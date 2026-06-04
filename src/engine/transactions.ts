/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import { Transaction, TxStatus, Row, DbValue } from "../types";
import { StorageEngine } from "./storage";

export class TransactionEngine {
  private storage: StorageEngine;
  private transactions: Map<number, Transaction> = new Map();
  private nextTxId = 1001;
  private committedTxs: Set<number> = new Set([0]); // Tx 0 represents initial bootstrapped data

  constructor(storage: StorageEngine) {
    this.storage = storage;
    this.loadTransactions();
  }

  private loadTransactions() {
    this.storage.log("TX", "INFO", "Initializing transaction subsystems. Restoring state matrices...");
    const storedCommitted = localStorage.getItem("aureum_db_committed_txs");
    if (storedCommitted) {
      try {
        const arr = JSON.parse(storedCommitted) as number[];
        arr.forEach((id) => this.committedTxs.add(id));
        this.nextTxId = Math.max(...arr, 1000) + 1;
        this.storage.log("TX", "SUCCESS", `Restored metadata for ${this.committedTxs.size} committed transactions.`);
      } catch (e) {
        this.storage.log("TX", "WARNING", "Error restoring transactions. Defaulting.");
      }
    }
  }

  private saveTransactions() {
    localStorage.setItem("aureum_db_committed_txs", JSON.stringify(Array.from(this.committedTxs)));
  }

  // BEGIN Transaction
  public beginTransaction(isolationLevel: "READ_COMMITTED" | "SERIALIZABLE" = "READ_COMMITTED"): Transaction {
    const txId = this.nextTxId++;
    const tx: Transaction = {
      id: txId,
      status: TxStatus.ACTIVE,
      startedAt: new Date().toLocaleTimeString(),
      isolationLevel,
      touchedRows: [],
    };
    this.transactions.set(txId, tx);
    this.storage.log("TX", "SUCCESS", `BEGIN Transaction [${txId}]. Isolation level: ${isolationLevel}`);
    return tx;
  }

  // COMMIT Transaction
  public commitTransaction(txId: number) {
    const tx = this.transactions.get(txId);
    if (!tx) {
      this.storage.log("TX", "ERROR", `Transaction [${txId}] not found.`);
      return;
    }
    if (tx.status !== TxStatus.ACTIVE) {
      this.storage.log("TX", "ERROR", `Transaction [${txId}] is not active (status: ${tx.status}).`);
      return;
    }

    tx.status = TxStatus.COMMITTED;
    this.committedTxs.add(txId);
    this.saveTransactions();
    
    // In WAL system, commits are instantly flushed to logs, and dirty pages eventually checkpointed
    this.storage.log("TX", "SUCCESS", `COMMIT Transaction [${txId}] successful. All row versions materialized to catalog.`);
  }

  // ROLLBACK Transaction
  public rollbackTransaction(txId: number) {
    const tx = this.transactions.get(txId);
    if (!tx) return;

    tx.status = TxStatus.ABORTED;
    this.storage.log("TX", "WARNING", `ROLLBACK Transaction [${txId}]. Initiating undo operations on MVCC row chain.`);
    
    // Undo MVCC changes: revert row status for mutated rows
    tx.touchedRows.forEach(({ tableName, rowId, prevVersionId }) => {
      // Find row in the database sheets and remove/restore previous state
      const pages = this.storage.getAllPages();
      const pageToFix = pages.find(p => p.tableName === tableName && p.rows.some(r => r.id === rowId));
      if (pageToFix) {
        // If we inserted a row, we turn it expired instantly (or delete it from page rows)
        const rowIdx = pageToFix.rows.findIndex(r => r.id === rowId);
        if (rowIdx !== -1) {
          const row = pageToFix.rows[rowIdx];
          if (row.tx_created === txId) {
            // Created in this rolled back transaction. Delete it!
            pageToFix.rows.splice(rowIdx, 1);
            pageToFix.header.slot_count--;
            this.storage.writePage(pageToFix.header.page_id, pageToFix);
            this.storage.log("TX", "INFO", `[UNDO] Reverted row insertion for ID "${rowId}" under rollbacked transaction [${txId}].`);
          } else if (row.tx_expired === txId) {
            // Expired in this rolled back transaction. Restore it!
            row.tx_expired = null;
            this.storage.writePage(pageToFix.header.page_id, pageToFix);
            this.storage.log("TX", "INFO", `[UNDO] Restored row version expire lease for ID "${rowId}". Row reactivated.`);
          }
        }
      }
    });

    this.storage.log("TX", "SUCCESS", `ROLLBACK Transaction [${txId}] complete. Consistent state restored.`);
  }

  public getTransaction(txId: number): Transaction | undefined {
    return this.transactions.get(txId);
  }

  public getCommittedTransactions(): Set<number> {
    return this.committedTxs;
  }

  public getActiveTransactions(): Transaction[] {
    return Array.from(this.transactions.values()).filter(t => t.status === TxStatus.ACTIVE);
  }

  /**
   * MVCC Visibility Rule Checker: Evaluates if a row version is visible to a reading transaction.
   * Based on PostgreSql heap tuple eligibility check.
   */
  public isRowVisible(row: Row, readerTxId: number | null): boolean {
    const createdBy = row.tx_created;
    const expiredBy = row.tx_expired;

    // If writing transaction itself is doing the read
    if (readerTxId !== null && createdBy === readerTxId) {
      // We can see things we created, unless we expired them ourselves
      return expiredBy !== readerTxId;
    }

    // 1. Check insertion visibility
    const isInsertionCommitted = this.committedTxs.has(createdBy);
    if (!isInsertionCommitted) {
      // Uncommitted row from another transaction is invisible
      return false;
    }

    // 2. Check deletion visibility
    if (expiredBy === null) {
      // Row is inserted and never deleted/expired
      return true;
    }

    if (readerTxId !== null && expiredBy === readerTxId) {
      // Current transaction deleted this row. Invisible.
      return false;
    }

    const isDeletionCommitted = this.committedTxs.has(expiredBy);
    if (!isDeletionCommitted) {
      // Deletion occurred but has NOT committed yet. The row is still visible!
      return true;
    }

    // Both insertion and deletion committed. Invisible as it is superseded by a newer version.
    return false;
  }

  public recordMutation(txId: number, tableName: string, rowId: string, prevVersionId: string | null) {
    const tx = this.transactions.get(txId);
    if (tx) {
      tx.touchedRows.push({ tableName, rowId, prevVersionId });
    }
  }

  public wipeTransactions() {
    this.transactions.clear();
    this.committedTxs = new Set([0]);
    this.nextTxId = 1001;
    this.saveTransactions();
  }
}
