/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import { LogRecord, LogType, DbValue, Row } from "../types";
import { StorageEngine } from "./storage";

export class WriteAheadLogger {
  private storage: StorageEngine;
  private walRecords: LogRecord[] = [];
  private nextLsn = 10001;

  constructor(storage: StorageEngine) {
    this.storage = storage;
    this.loadWALFromDisk();
  }

  private loadWALFromDisk() {
    this.storage.log("WAL", "INFO", "Initializing Write-Ahead Logging (WAL) manager...");
    const walStr = localStorage.getItem("aureum_db_wal");
    if (walStr) {
      try {
        this.walRecords = JSON.parse(walStr) as LogRecord[];
        this.nextLsn = Math.max(...this.walRecords.map((r) => r.lsn), 10000) + 1;
        this.storage.log("WAL", "SUCCESS", `Loaded existing WAL file with ${this.walRecords.length} records from persistent disk.`);
      } catch (e) {
        this.storage.log("WAL", "WARNING", "Error reading WAL records. Starting with a blank WAL file.");
      }
    }
  }

  private saveWALToDisk() {
    localStorage.setItem("aureum_db_wal", JSON.stringify(this.walRecords));
  }

  /**
   * Appends an entry to the Write-Ahead Log.
   * Crucial principle: WAL must be written to disk BEFORE the corresponding page is flushed.
   */
  public log(
    txId: number,
    type: LogType,
    tableName?: string,
    rowId?: string,
    beforeImage?: Record<string, DbValue>,
    afterImage?: Record<string, DbValue>
  ): number {
    const lsn = this.nextLsn++;
    const record: LogRecord = {
      lsn,
      tx_id: txId,
      type,
      tableName,
      rowId,
      beforeImage,
      afterImage,
      timestamp: new Date().toLocaleTimeString(),
    };
    
    this.walRecords.push(record);
    this.saveWALToDisk();

    this.storage.log(
      "WAL",
      "SUCCESS",
      `[WAL] Appended LSN [${lsn}] to log: Tx [${txId}] ${type} ${tableName || ""} ID "${rowId || ""}"`
    );
    
    return lsn;
  }

  public getWALRecords(): LogRecord[] {
    return this.walRecords;
  }

  public clearWAL() {
    this.walRecords = [];
    this.nextLsn = 10001;
    this.saveWALToDisk();
  }

  /**
   * Perform ARIES crash recovery protocol (Analysis, REDO, UNDO phases).
   * Repairs the storage page catalog using the Write-Ahead Log up to the last committed transact state.
   */
  public runRecovery(committedTxSet: Set<number>, activeTxIdSetter: (activeIds: number[]) => void): { replayedCount: number; undoneCount: number; logs: string[] } {
    const recoveryLogs: string[] = [];
    recoveryLogs.push("=================== ARIES STARTUP RECOVERY ===================");
    this.storage.log("WAL", "WARNING", "Initiating system recovery. Checking WAL signatures...");

    if (this.walRecords.length === 0) {
      recoveryLogs.push("WAL is clean. No transactions to recover.");
      return { replayedCount: 0, undoneCount: 0, logs: recoveryLogs };
    }

    // --- 1. ANALYSIS PHASE ---
    recoveryLogs.push("[Phase 1] Analysis: Reading log stream to establish active transactions and dirty pages.");
    const activeTxsDuringCrash: Set<number> = new Set();
    
    this.walRecords.forEach((record) => {
      if (record.type === LogType.BEGIN) {
        activeTxsDuringCrash.add(record.tx_id);
      } else if (record.type === LogType.COMMIT || record.type === LogType.ABORT) {
        activeTxsDuringCrash.delete(record.tx_id);
      }
    });

    recoveryLogs.push(`Analysis complete. Active uncommitted Transactions during crash: [${Array.from(activeTxsDuringCrash).join(", ") || "None"}]`);

    // --- 2. REDO PHASE (REPLAY) ---
    recoveryLogs.push("[Phase 2] Redo (Repeat History): Replaying all catalog modifications to bring pages of disk to crash time.");
    let replayedCount = 0;

    // Scan forward and apply all changes
    this.walRecords.forEach((record) => {
      if (record.type === LogType.INSERT || record.type === LogType.UPDATE || record.type === LogType.DELETE) {
        const { tableName, rowId, afterImage, tx_id } = record;
        if (!tableName || !rowId) return;

        recoveryLogs.push(`REDO: LSN [${record.lsn}] replaying transaction Tx [${tx_id}] modification for row "${rowId}" on Table "${tableName}"`);
        
        // Find corresponding physical page
        const pages = this.storage.getAllPages();
        let targetPage = pages.find((p) => p.tableName === tableName && p.rows.some((r) => r.id === rowId));
        
        if (!targetPage) {
          // If inserting a record to a new space, find appropriate DATA page or allocate
          targetPage = pages.find((p) => p.tableName === tableName && p.header.page_type === "DATA");
        }

        if (targetPage) {
          // Check LSN representation to prevent double-writes
          if (targetPage.header.tx_lsn <= record.lsn) {
            const rowIdx = targetPage.rows.findIndex((r) => r.id === rowId);

            if (record.type === LogType.INSERT && afterImage) {
              if (rowIdx === -1) {
                targetPage.rows.push({
                  id: rowId,
                  tx_created: tx_id,
                  tx_expired: null,
                  rollback_ptr: null,
                  data: afterImage,
                });
                targetPage.header.slot_count++;
              }
            } else if (record.type === LogType.UPDATE && afterImage) {
              if (rowIdx !== -1) {
                targetPage.rows[rowIdx].data = afterImage;
              }
            } else if (record.type === LogType.DELETE) {
              if (rowIdx !== -1) {
                targetPage.rows[rowIdx].tx_expired = tx_id;
              }
            }
            
            targetPage.header.tx_lsn = record.lsn;
            this.storage.writePage(targetPage.header.page_id, targetPage);
            replayedCount++;
          } else {
            recoveryLogs.push(`Skipped REDO for LSN [${record.lsn}]: Page has newer Log LSN [${targetPage.header.tx_lsn}]`);
          }
        }
      }
    });

    recoveryLogs.push(`Redo Phase complete. Replayed ${replayedCount} low-level operations.`);

    // --- 3. UNDO PHASE ---
    recoveryLogs.push("[Phase 3] Undo (Rollback Active): Reverting modifications from transactions that never committed before crash.");
    let undoneCount = 0;

    // Scan backward to undo changes. In real databases, we reverse each action step
    const reversedRecords = [...this.walRecords].reverse();
    reversedRecords.forEach((record) => {
      if (activeTxsDuringCrash.has(record.tx_id)) {
        if (record.type === LogType.INSERT || record.type === LogType.UPDATE || record.type === LogType.DELETE) {
          const { tableName, rowId, beforeImage } = record;
          if (!tableName || !rowId) return;

          recoveryLogs.push(`UNDO: LSN [${record.lsn}] rolling back uncommitted Tx [${record.tx_id}] modification of row ID "${rowId}"`);
          
          const pages = this.storage.getAllPages();
          const targetPage = pages.find((p) => p.tableName === tableName && p.rows.some((r) => r.id === rowId));
          
          if (targetPage) {
            const rowIdx = targetPage.rows.findIndex((r) => r.id === rowId);
            if (rowIdx !== -1) {
              if (record.type === LogType.INSERT) {
                // To undo an insert, delete the item
                targetPage.rows.splice(rowIdx, 1);
                targetPage.header.slot_count--;
              } else if (record.type === LogType.UPDATE && beforeImage) {
                // To undo an update, restore the beforeImage
                targetPage.rows[rowIdx].data = beforeImage;
                targetPage.rows[rowIdx].tx_expired = null;
              } else if (record.type === LogType.DELETE) {
                // To undo a delete, unexpire the row
                targetPage.rows[rowIdx].tx_expired = null;
              }
              
              targetPage.header.tx_lsn = record.lsn;
              this.storage.writePage(targetPage.header.page_id, targetPage);
              undoneCount++;
            }
          }
        }
      }
    });

    // Save recovery log checklist
    activeTxsDuringCrash.forEach(txId => {
      committedTxSet.delete(txId); // Mark these as definitely aborted
    });

    recoveryLogs.push(`Undo Phase complete. Rolled back ${undoneCount} actions.`);
    recoveryLogs.push(`=================== RECOVERY SUCCESSFUL ===================`);
    this.storage.log("WAL", "SUCCESS", `Engine recovered successfully from crash! Replayed: ${replayedCount}, Undone: ${undoneCount}. Database is durable and consistent.`);

    // Sync state to disk
    this.storage.syncToDisk();

    return { replayedCount, undoneCount, logs: recoveryLogs };
  }
}
