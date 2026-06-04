/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import { StorageEngine } from "./storage";
import { IndexingEngine } from "./indexing";
import { TransactionEngine } from "./transactions";
import { WriteAheadLogger } from "./wal";
import { SQLParser } from "./parser";
import { ExecutionResult, DataType, TableSchema, LogType, PageType, Row, DbValue } from "../types";

export class AureumDatabase {
  public storage: StorageEngine;
  public index: IndexingEngine;
  public tx: TransactionEngine;
  public wal: WriteAheadLogger;
  public parser: SQLParser;

  private sqlHistory: string[] = [];
  public activeTxId: number | null = null;
  private schemas: Map<string, TableSchema> = new Map();

  constructor() {
    this.storage = new StorageEngine();
    this.index = new IndexingEngine(this.storage);
    this.tx = new TransactionEngine(this.storage);
    this.wal = new WriteAheadLogger(this.storage);
    this.parser = new SQLParser();

    this.loadSchemasFromStorage();
  }

  // Reload metadata schemas from storage Engine Page 0
  private loadSchemasFromStorage() {
    try {
      const page0 = this.storage.getPage(0);
      page0.rows.forEach((row) => {
        if (row.id.startsWith("schema_")) {
          const schema = row.data as unknown as TableSchema;
          this.schemas.set(schema.name, schema);
        }
      });
      this.storage.log("QUERY", "INFO", `Loaded ${this.schemas.size} relational database schemas from Page [0].`);
    } catch (e) {
      this.storage.log("QUERY", "ERROR", "Failed to deserialize schemas from Page 0.");
    }
  }

  /**
   * Run startup WAL recovery log shipping and replays on active system boot
   */
  public bootRecovery(): { replayedCount: number; undoneCount: number; logs: string[] } {
    const recoveryDetails = this.wal.runRecovery(this.tx.getCommittedTransactions(), (activeIds) => {
      if (activeIds.length > 0) {
        this.activeTxId = activeIds[0];
      }
    });
    this.loadSchemasFromStorage(); // re-sync metadata schemas after recovery
    return recoveryDetails;
  }

  public getSchemas(): TableSchema[] {
    return Array.from(this.schemas.values());
  }

  public getSqlHistory(): string[] {
    return this.sqlHistory;
  }

  /**
   * The core SQL parser & execution orchestrator engine
   */
  public executeQuery(sql: string): ExecutionResult {
    this.sqlHistory.push(sql);
    this.storage.log("CLI", "INFO", `[CLI] Received input: "${sql}"`);

    const queryLogs = this.storage.getLogs();
    const logStartOffset = queryLogs.length;

    try {
      const ast = this.parser.parse(sql);
      
      // 1. Transaction Handlers
      if (ast.type === "BEGIN") {
        if (this.activeTxId !== null) {
          throw new Error(`Invalid transaction: Transaction [${this.activeTxId}] is already active.`);
        }
        const txObj = this.tx.beginTransaction(ast.isolation);
        this.activeTxId = txObj.id;
        this.wal.log(this.activeTxId, LogType.BEGIN);
        
        return this.buildResult(true, `Transaction [${this.activeTxId}] initiated with ${ast.isolation} isolation.`, [], logStartOffset);
      }

      if (ast.type === "COMMIT") {
        if (this.activeTxId === null) {
          throw new Error("No active transaction to commit. Run 'BEGIN' first.");
        }
        const tid = this.activeTxId;
        this.tx.commitTransaction(tid);
        this.wal.log(tid, LogType.COMMIT);
        this.activeTxId = null;

        // Auto-flush pages corresponding to the commit to visual disk
        this.storage.syncToDisk();

        return this.buildResult(true, `Transaction [${tid}] committed successfully. FSYNC complete. WAL synced.`, [], logStartOffset);
      }

      if (ast.type === "ROLLBACK") {
        if (this.activeTxId === null) {
          throw new Error("No active transaction to rollback.");
        }
        const tid = this.activeTxId;
        this.tx.rollbackTransaction(tid);
        this.wal.log(tid, LogType.ABORT);
        this.activeTxId = null;

        return this.buildResult(true, `Transaction [${tid}] rolled back successfully. MVCC chain restored.`, [], logStartOffset);
      }

      // 2. Data Definition Language (DDL) Handlers
      if (ast.type === "CREATE_TABLE") {
        if (this.schemas.has(ast.tableName)) {
          throw new Error(`Table "${ast.tableName}" already exists in Page 0 catalog.`);
        }

        const newSchema: TableSchema = {
          name: ast.tableName,
          primaryKey: ast.primaryKey,
          columns: ast.columns,
          indices: [{ name: `idx_${ast.tableName}_${ast.primaryKey}`, columns: [ast.primaryKey], type: "B-TREE" }],
        };

        // Standard 4KB Data Page Allocate
        const dataPage = this.storage.allocateNewPage(PageType.DATA, ast.tableName);
        
        // Root B-Tree index allocate
        const idxPage = this.storage.allocateNewPage(PageType.INDEX_BTREE, ast.tableName);
        idxPage.btree = {
          isLeaf: true,
          keys: [],
          children: [],
          parent: null,
        };
        this.storage.writePage(idxPage.header.page_id, idxPage);

        this.schemas.set(ast.tableName, newSchema);

        // Update Page 0 catalog schemas
        const page0 = this.storage.getPage(0);
        page0.rows.push({
          id: `schema_${ast.tableName}`,
          tx_created: 0,
          tx_expired: null,
          rollback_ptr: null,
          data: newSchema as any,
        });
        page0.header.slot_count = page0.rows.length;
        this.storage.writePage(0, page0);
        
        // Save database
        this.storage.syncToDisk();

        this.storage.log("QUERY", "SUCCESS", `Table "${ast.tableName}" successfully materialized under Data Page [${dataPage.header.page_id}] and Index Page [${idxPage.header.page_id}].`);
        return this.buildResult(true, `Table "${ast.tableName}" created. Data allocated on Page [${dataPage.header.page_id}]. Index allocated on Page [${idxPage.header.page_id}].`, [], logStartOffset);
      }

      if (ast.type === "DROP_TABLE") {
        if (!this.schemas.has(ast.tableName)) {
          throw new Error(`Table "${ast.tableName}" does not exist.`);
        }

        this.schemas.delete(ast.tableName);
        
        // Remove from Page 0 rows schema
        const page0 = this.storage.getPage(0);
        page0.rows = page0.rows.filter(r => r.id !== `schema_${ast.tableName}`);
        page0.header.slot_count = page0.rows.length;
        this.storage.writePage(0, page0);

        // Iterate through physical disk mapping and delete pages mapped to this table name
        const pages = this.storage.getAllPages();
        pages.forEach((p) => {
          if (p.tableName === ast.tableName) {
            // Reclaim by switching type to FREE_LIST
            p.header.page_type = PageType.FREE_LIST;
            p.rows = [];
            p.slots = [];
            p.btree = undefined;
            this.storage.writePage(p.header.page_id, p);
            this.storage.log("STORAGE", "WARNING", `Reclaimed Page [${p.header.page_id}] of "${ast.tableName}". Allocated to Free List.`);
          }
        });

        this.storage.syncToDisk();
        return this.buildResult(true, `Table "${ast.tableName}" dropped. Active page clusters reclaimed to Page Freelist.`, [], logStartOffset);
      }

      if (ast.type === "CREATE_INDEX") {
        const schema = this.schemas.get(ast.tableName);
        if (!schema) {
          throw new Error(`Table "${ast.tableName}" does not exist to assign index.`);
        }

        // Add Index details to schema
        schema.indices.push({ name: ast.indexName, columns: ast.columns, type: ast.indexType });
        this.schemas.set(ast.tableName, schema);

        // Allocate physical Index page
        const idxPageType = ast.indexType === "HASH" ? PageType.INDEX_HASH : PageType.INDEX_BTREE;
        const indexPage = this.storage.allocateNewPage(idxPageType, ast.tableName);
        
        if (ast.indexType === "B-TREE") {
          indexPage.btree = { isLeaf: true, keys: [], children: [], parent: null };
          this.storage.writePage(indexPage.header.page_id, indexPage);
        }

        // Re-read existing rows from pages to populate newly generated index!
        const pages = this.storage.getAllPages();
        const dataPages = pages.filter((p) => p.tableName === ast.tableName && p.header.page_type === PageType.DATA);
        
        dataPages.forEach((dp) => {
          dp.rows.forEach((row) => {
            if (this.tx.isRowVisible(row, this.activeTxId)) {
              const val = row.data[ast.columns[0]];
              if (val !== undefined) {
                if (ast.indexType === "B-TREE") {
                  if (typeof val === "string" || typeof val === "number") {
                    this.index.insertIntoBTree(indexPage.header.page_id, val, dp.header.page_id);
                  }
                } else {
                  this.index.insertIntoHash(indexPage.header.page_id, String(val), dp.header.page_id);
                }
              }
            }
          });
        });

        this.storage.syncToDisk();
        return this.buildResult(true, `Created ${ast.indexType} index "${ast.indexName}" on Page [${indexPage.header.page_id}]. Seeding indexes complete.`, [], logStartOffset);
      }

      // Convert indices detail map for query execution planning
      const indicesMap: Map<string, any[]> = new Map();
      this.schemas.forEach((schema, tbl) => {
        const pages = this.storage.getAllPages();
        const mappedIdxs = schema.indices.map((idxInfo) => {
          const matchedPage = pages.find(p => p.tableName === tbl && p.header.page_type.startsWith("INDEX_") && p.header.page_type.endsWith(idxInfo.type.replace("-", "")));
          return {
            ...idxInfo,
            page_id: matchedPage ? matchedPage.header.page_id : null,
          };
        });
        indicesMap.set(tbl, mappedIdxs);
      });

      // 3. Select Command Handler
      if (ast.type === "SELECT") {
        const plan = this.parser.generatePlan(ast, this.schemas, indicesMap);
        
        const schema = this.schemas.get(ast.tableName);
        if (!schema) {
          throw new Error(`Table "${ast.tableName}" not found.`);
        }

        // Get target DATA pages by checking if we have index selection optimized
        const pages = this.storage.getAllPages();
        let matchedDataPageIds: number[] = [];

        const tableIndices = indicesMap.get(ast.tableName) || [];
        if (ast.filter && tableIndices.length > 0) {
          const filterCol = ast.filter.column;
          const filterVal = ast.filter.value;
          const matchingIdx = tableIndices.find((idx) => idx.columns.includes(filterCol));

          if (matchingIdx && matchingIdx.page_id !== null) {
            if (matchingIdx.type === "B-TREE" && ast.filter.operator === "=") {
              const { dataPageId } = this.index.searchBTree(matchingIdx.page_id, filterVal);
              if (dataPageId !== -1) {
                matchedDataPageIds = [dataPageId];
              }
            } else if (matchingIdx.type === "HASH" && ast.filter.operator === "=") {
              const { pageIds } = this.index.searchHash(matchingIdx.page_id, String(filterVal));
              if (pageIds.length > 0) {
                matchedDataPageIds = pageIds;
              }
            }
          }
        }

        // Fallback: Seq scan all visual data pages associated with tableName
        if (matchedDataPageIds.length === 0) {
          matchedDataPageIds = pages
            .filter((p) => p.tableName === ast.tableName && p.header.page_type === PageType.DATA)
            .map((p) => p.header.page_id);
          this.storage.log("QUERY", "WARNING", `Table scan fallback. Performing linear Seq-Scan on Data Pages: [${matchedDataPageIds.join(", ")}]`);
        }

        // Collect rows and process MVCC Visibility check
        let queryRows: Record<string, DbValue>[] = [];
        matchedDataPageIds.forEach((pid) => {
          const dPage = this.storage.getPage(pid);
          dPage.rows.forEach((row) => {
            if (this.tx.isRowVisible(row, this.activeTxId)) {
              // Row passes active transaction MVCC check
              queryRows.push({ ...row.data });
            }
          });
        });

        // Apply where filter sequentially if index lookup didn't fully resolve it (or as secondary filter)
        if (ast.filter) {
          const { column, operator, value } = ast.filter;
          queryRows = queryRows.filter((row) => {
            const rowVal = row[column];
            if (rowVal === undefined || rowVal === null) return false;
            if (operator === "=") return String(rowVal).toLowerCase() === String(value).toLowerCase();
            if (operator === "!=") return String(rowVal).toLowerCase() !== String(value).toLowerCase();
            if (operator === ">") return Number(rowVal) > Number(value);
            if (operator === "<") return Number(rowVal) < Number(value);
            return false;
          });
        }

        // Relational JOIN logic
        if (ast.join) {
          const joinTable = ast.join.table;
          const onLeft = ast.join.onLeft.split(".")[1]; // customers.id -> id
          const onRight = ast.join.onRight.split(".")[1]; // orders.customer_id -> customer_id

          const joinRows: Record<string, DbValue>[] = [];
          const joinDataPages = pages.filter((p) => p.tableName === joinTable && p.header.page_type === PageType.DATA);
          const rawJoinRows: Record<string, DbValue>[] = [];

          joinDataPages.forEach((jP) => {
            jP.rows.forEach((row) => {
              if (this.tx.isRowVisible(row, this.activeTxId)) {
                rawJoinRows.push({ ...row.data });
              }
            });
          });

          // Join rows
          queryRows.forEach((primaryRow) => {
            const leftVal = primaryRow[onLeft];
            const matchingInnerRows = rawJoinRows.filter((jRow) => String(jRow[onRight]) === String(leftVal));

            matchingInnerRows.forEach((innerRow) => {
              const joinedObj: Record<string, DbValue> = {};
              // Namespace both sides
              Object.entries(primaryRow).forEach(([k, v]) => {
                joinedObj[`${ast.tableName}.${k}`] = v;
              });
              Object.entries(innerRow).forEach(([k, v]) => {
                joinedObj[`${joinTable}.${k}`] = v;
              });
              joinRows.push(joinedObj);
            });
          });

          queryRows = joinRows;
        }

        // Sorting
        if (ast.orderBy) {
          const col = ast.orderBy.column;
          const isDesc = ast.orderBy.dir === "DESC";
          queryRows.sort((a, b) => {
            let left = a[col] ?? "";
            let right = b[col] ?? "";
            if (typeof left === "number" && typeof right === "number") {
              return isDesc ? right - left : left - right;
            }
            return isDesc
              ? String(right).localeCompare(String(left))
              : String(left).localeCompare(String(right));
          });
        }

        // Limit
        if (ast.limit !== null) {
          queryRows = queryRows.slice(0, ast.limit);
        }

        this.storage.log("QUERY", "SUCCESS", `SELECT completed. Returned ${queryRows.length} tuples successfully.`);
        return this.buildResult(true, `SELECT yielded ${queryRows.length} tuples.`, queryRows, logStartOffset, plan);
      }

      // 4. Mutation Handlers (Requires active / implicit transactions)
      let txnIsImplicit = false;
      if (this.activeTxId === null) {
        // Implicit single-statement transaction standard
        const implTx = this.tx.beginTransaction("READ_COMMITTED");
        this.activeTxId = implTx.id;
        this.wal.log(this.activeTxId, LogType.BEGIN);
        txnIsImplicit = true;
      }

      const activeTid = this.activeTxId!;

      if (ast.type === "INSERT") {
        const schema = this.schemas.get(ast.tableName);
        if (!schema) {
          throw new Error(`Table "${ast.tableName}" not found.`);
        }

        const pages = this.storage.getAllPages();
        const primaryCol = schema.primaryKey;
        const insertPk = ast.rowData[primaryCol];

        if (insertPk === undefined) {
          throw new Error(`Insert aborted: Table Primary Key "${primaryCol}" must be specified.`);
        }

        // Find standard DATA page with free space or make a new one
        let dataPage = pages.find((p) => p.tableName === ast.tableName && p.header.page_type === PageType.DATA);
        if (!dataPage || dataPage.rows.length >= 7) { 
          // Artificially low list size limit to trigger splitting and page creation visualizations!
          dataPage = this.storage.allocateNewPage(PageType.DATA, ast.tableName);
        }

        const dataPageId = dataPage.header.page_id;
        const rowId = `${ast.tableName}_${insertPk}`;

        // Verify key uniqueness under MVCC: we check if active visible duplicate exists
        const duplicateCheck = pages
          .filter((p) => p.tableName === ast.tableName && p.header.page_type === PageType.DATA)
          .flatMap((p) => p.rows)
          .find((r) => r.id === rowId && this.tx.isRowVisible(r, activeTid));

        if (duplicateCheck) {
          throw new Error(`Unique constraint violation: Primary key "${insertPk}" already exists in table.`);
        }

        // Write WAL Record BEFORE modifying pages -> Standard WAL protocol!
        const lsn = this.wal.log(activeTid, LogType.INSERT, ast.tableName, rowId, undefined, ast.rowData);

        // Modify Page structure inside cache
        const rowSize = JSON.stringify(ast.rowData).length;
        const slot = {
          offset: dataPage.header.free_space_pointer - rowSize,
          length: rowSize,
        };
        dataPage.header.free_space_pointer = slot.offset;
        dataPage.header.slot_count++;
        dataPage.slots.push(slot);
        
        const newRow: Row = {
          id: rowId,
          tx_created: activeTid,
          tx_expired: null,
          rollback_ptr: null,
          data: ast.rowData,
        };
        dataPage.rows.push(newRow);
        
        // Update Log Sequence Number on page
        dataPage.header.tx_lsn = lsn;
        this.storage.writePage(dataPageId, dataPage);

        // Log mutation in history for potential rollbacks
        this.tx.recordMutation(activeTid, ast.tableName, rowId, null);

        // Update corresponding indices
        const indices = indicesMap.get(ast.tableName) || [];
        indices.forEach((idx) => {
          if (idx.page_id !== null) {
            const indexedAttrVal = ast.rowData[idx.columns[0]];
            if (indexedAttrVal !== undefined && indexedAttrVal !== null) {
              if (idx.type === "B-TREE") {
                if (typeof indexedAttrVal === "string" || typeof indexedAttrVal === "number") {
                  this.index.insertIntoBTree(idx.page_id, indexedAttrVal, dataPageId);
                }
              } else {
                this.index.insertIntoHash(idx.page_id, String(indexedAttrVal), dataPageId);
              }
            }
          }
        });

        if (txnIsImplicit) {
          // Commit immediate implicit transaction
          this.tx.commitTransaction(activeTid);
          this.wal.log(activeTid, LogType.COMMIT);
          this.activeTxId = null;
          this.storage.syncToDisk();
          this.storage.log("QUERY", "SUCCESS", `Implicit Tx [${activeTid}] committed immediately. Row persistent.`);
        }

        return this.buildResult(true, `INSERT successful on implicit Transaction [${activeTid}]. Row visual page allocated.`, [], logStartOffset);
      }

      if (ast.type === "UPDATE_MUTATION") {
        const schema = this.schemas.get(ast.tableName);
        if (!schema) {
          throw new Error(`Table "${ast.tableName}" not found.`);
        }

        const pages = this.storage.getAllPages();
        const dataPages = pages.filter((p) => p.tableName === ast.tableName && p.header.page_type === PageType.DATA);
        
        let affected = 0;

        dataPages.forEach((dp) => {
          const pageId = dp.header.page_id;
          
          // Work on copy to allow safe mutation loops
          const originalRows = [...dp.rows];
          originalRows.forEach((row, idx) => {
            if (this.tx.isRowVisible(row, activeTid)) {
              // Apply filter
              let matches = true;
              if (ast.filter) {
                const rowVal = row.data[ast.filter.column];
                if (ast.filter.operator === "=") matches = String(rowVal).toLowerCase() === String(ast.filter.value).toLowerCase();
                else if (ast.filter.operator === ">") matches = Number(rowVal) > Number(ast.filter.value);
                else if (ast.filter.operator === "<") matches = Number(rowVal) < Number(ast.filter.value);
              }

              if (matches) {
                // UPDATE implementation with MVCC:
                // 1. Mark current row version as expired by active transaction id
                const oldBeforeImage = { ...row.data };
                row.tx_expired = activeTid;
                this.storage.writePage(pageId, dp);

                // 2. Insert new row version in target or fresh page
                const updatedData = { ...row.data, [ast.setColumn]: ast.setValue };
                const newRowId = `${ast.tableName}_${row.data[schema.primaryKey]}_v_${Date.now()}_${Math.random().toString(36).substr(2,3)}`;

                // Write WAL Record BEFORE altering
                const lsn = this.wal.log(activeTid, LogType.UPDATE, ast.tableName, row.id, oldBeforeImage, updatedData);

                // Re-write to storage containing new page structure cell slots
                let activeDataPage = dp;
                if (dp.rows.length >= 7) {
                  activeDataPage = this.storage.allocateNewPage(PageType.DATA, ast.tableName);
                }

                activeDataPage.rows.push({
                  id: row.id, // Keeps same logical ID to match secondary indexes!
                  tx_created: activeTid,
                  tx_expired: null,
                  rollback_ptr: row.id, // Rolls back to former version pointer
                  data: updatedData,
                });
                activeDataPage.header.slot_count = activeDataPage.rows.length;
                activeDataPage.header.tx_lsn = lsn;
                this.storage.writePage(activeDataPage.header.page_id, activeDataPage);

                this.tx.recordMutation(activeTid, ast.tableName, row.id, row.id);
                affected++;
              }
            }
          });
        });

        if (txnIsImplicit) {
          this.tx.commitTransaction(activeTid);
          this.wal.log(activeTid, LogType.COMMIT);
          this.activeTxId = null;
          this.storage.syncToDisk();
        }

        return this.buildResult(true, `UPDATE affected ${affected} rows.`, [], logStartOffset, undefined, affected);
      }

      if (ast.type === "DELETE_MUTATION") {
        const schema = this.schemas.get(ast.tableName);
        if (!schema) {
          throw new Error(`Table "${ast.tableName}" not found.`);
        }

        const pages = this.storage.getAllPages();
        const dataPages = pages.filter((p) => p.tableName === ast.tableName && p.header.page_type === PageType.DATA);
        
        let affected = 0;

        dataPages.forEach((dp) => {
          const pageId = dp.header.page_id;
          dp.rows.forEach((row) => {
            if (this.tx.isRowVisible(row, activeTid)) {
              let matches = true;
              if (ast.filter) {
                const rowVal = row.data[ast.filter.column];
                if (ast.filter.operator === "=") matches = String(rowVal).toLowerCase() === String(ast.filter.value).toLowerCase();
                else if (ast.filter.operator === ">") matches = Number(rowVal) > Number(ast.filter.value);
                else if (ast.filter.operator === "<") matches = Number(rowVal) < Number(ast.filter.value);
              }

              if (matches) {
                // DELETE implementation in MVCC: marks row expired lease
                const beforeImage = { ...row.data };
                const lsn = this.wal.log(activeTid, LogType.DELETE, ast.tableName, row.id, beforeImage, undefined);

                row.tx_expired = activeTid;
                dp.header.tx_lsn = lsn;
                this.storage.writePage(pageId, dp);

                this.tx.recordMutation(activeTid, ast.tableName, row.id, null);
                affected++;
              }
            }
          });
        });

        if (txnIsImplicit) {
          this.tx.commitTransaction(activeTid);
          this.wal.log(activeTid, LogType.COMMIT);
          this.activeTxId = null;
          this.storage.syncToDisk();
        }

        return this.buildResult(true, `DELETE successfully purged ${affected} tuples mapping.`, [], logStartOffset, undefined, affected);
      }

    } catch (err: any) {
      this.storage.log("CLI", "ERROR", `Evaluation failed: ${err.message}`);
      
      // Rollback active transaction if anything gets stuck inside implicit scope
      if (this.activeTxId !== null) {
        this.tx.rollbackTransaction(this.activeTxId);
        this.activeTxId = null;
      }
      
      return {
        success: false,
        message: err.message,
        logs: queryLogs.slice(logStartOffset),
      };
    }

    return { success: false, message: "Unhandled execution sequence.", logs: [] };
  }

  private buildResult(
    success: boolean,
    message: string,
    rows: Record<string, DbValue>[],
    logStartOffset: number,
    plan?: any,
    affectedRows?: number
  ): ExecutionResult {
    const rawLogs = this.storage.getLogs();
    const sliceLogs = rawLogs.slice(logStartOffset);
    return {
      success,
      message,
      rows,
      plan,
      affectedRows,
      logs: sliceLogs,
    };
  }

  public wipeAll() {
    this.storage.wipeDatabase();
    this.tx.wipeTransactions();
    this.wal.clearWAL();
    this.activeTxId = null;
    this.schemas.clear();
    this.loadSchemasFromStorage();
  }
}
