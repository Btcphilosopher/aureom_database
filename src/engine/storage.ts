/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import { Page, PageType, Row, PageSlot, LogMessage, DBMetadata, TableSchema, DataType } from "../types";

export class StorageEngine {
  private memoryDisk: Map<number, Page> = new Map();
  private bufferPool: Map<number, Page> = new Map(); // Implements LRU buffer pool
  private bufferPoolSize = 6; // Max 6 pages in cache
  private bufferLruQueue: number[] = [];
  private totalPages = 0;
  private logs: LogMessage[] = [];
  private diskWriteCounts = 0;
  private diskReadCounts = 0;

  constructor() {
    this.logs = [];
    this.loadFromDisk();
  }

  // Generate logs
  public log(module: "STORAGE" | "QUERY" | "TX" | "INDEX" | "WAL" | "CACHE" | "NET" | "CLI", level: "INFO" | "WARNING" | "ERROR" | "SUCCESS", message: string) {
    const timestamp = new Date().toLocaleTimeString();
    this.logs.push({ timestamp, module, level, message });
    // Keep last 400 logs
    if (this.logs.length > 400) {
      this.logs.shift();
    }
  }

  public getLogs(): LogMessage[] {
    return this.logs;
  }

  public clearLogs() {
    this.logs = [];
  }

  public getDiskStats() {
    return {
      diskWrites: this.diskWriteCounts,
      diskReads: this.diskReadCounts,
      hitRate: this.diskReadCounts + this.diskWriteCounts === 0 ? 100 : Math.round(( (this.diskReadCounts - this.diskWriteCounts) / Math.max(1, this.diskReadCounts) ) * 100),
      cachedPages: Array.from(this.bufferPool.keys()),
    };
  }

  // Load pages from localStorage, or initialize empty db with default values
  private loadFromDisk() {
    this.log("STORAGE", "INFO", "Initializing storage engine. Checking physical disk...");
    try {
      const metadataStr = localStorage.getItem("aureum_db_metadata");
      const pagesStr = localStorage.getItem("aureum_db_pages");

      if (metadataStr && pagesStr) {
        const pagesData = JSON.parse(pagesStr) as Page[];
        pagesData.forEach((p) => {
          this.memoryDisk.set(p.header.page_id, p);
        });
        this.totalPages = this.memoryDisk.size;
        this.log("STORAGE", "SUCCESS", `Loaded existing database with ${this.totalPages} pages from disk.`);
      } else {
        this.initializeDefaultDatabase();
      }
    } catch (e) {
      this.log("STORAGE", "WARNING", "Error reading disk storage, or first boot. Initializing clean database.");
      this.initializeDefaultDatabase();
    }
  }

  // Save the full disk state to localStorage (simulating physical sync)
  public syncToDisk() {
    try {
      // Write remaining dirty pages from Buffer Pool to Memory Disk
      this.bufferPool.forEach((page, pageId) => {
        this.memoryDisk.set(pageId, page);
        this.diskWriteCounts++;
      });
      
      const pagesArr = Array.from(this.memoryDisk.values());
      localStorage.setItem("aureum_db_pages", JSON.stringify(pagesArr));
      
      const dbMeta: DBMetadata = {
        name: "aureum_db",
        version: "1.0.0",
        created_at: "2026-06-04",
        page_size: 4096,
        total_pages: this.totalPages,
        wal_active: true,
      };
      localStorage.setItem("aureum_db_metadata", JSON.stringify(dbMeta));
      this.log("STORAGE", "SUCCESS", `FSYNC COMPLETE: Flushed all dirty pages. Saved ${this.totalPages} pages to persistent storage.`);
    } catch (e) {
      this.log("STORAGE", "ERROR", `Fsync failed: ${String(e)}`);
    }
  }

  // Erase the full database
  public wipeDatabase() {
    localStorage.removeItem("aureum_db_pages");
    localStorage.removeItem("aureum_db_metadata");
    localStorage.removeItem("aureum_db_wal");
    this.memoryDisk.clear();
    this.bufferPool.clear();
    this.bufferLruQueue = [];
    this.totalPages = 0;
    this.diskWriteCounts = 0;
    this.diskReadCounts = 0;
    this.initializeDefaultDatabase();
    this.log("STORAGE", "SUCCESS", "Database destroyed and reset to fresh installation state.");
  }

  // Crash simulation: buffer pool is wiped out instantly without syncing to persistent disk!
  public triggerCrash() {
    this.bufferPool.clear();
    this.bufferLruQueue = [];
    this.log("STORAGE", "WARNING", "SHUTDOWN IN PROGRESS (POWER LOSS)... Buffer pool volatile RAM cleared instantly! Non-synced dirty pages lost.");
    // Re-load the disk version to match what's on disk
    const pagesStr = localStorage.getItem("aureum_db_pages");
    if (pagesStr) {
      this.memoryDisk.clear();
      const loadedPages = JSON.parse(pagesStr) as Page[];
      loadedPages.forEach((p) => {
        this.memoryDisk.set(p.header.page_id, p);
      });
      this.totalPages = this.memoryDisk.size;
    }
  }

  // Reads a page from database. Uses Buffer Pool LRU cache.
  public getPage(pageId: number): Page {
    // 1. Buffer Cache Hit
    if (this.bufferPool.has(pageId)) {
      this.updateLruQueue(pageId);
      this.log("CACHE", "INFO", `Buffer Pool HIT on Page [${pageId}] (LRU list: [${this.bufferLruQueue.join(", ")}])`);
      return this.bufferPool.get(pageId)!;
    }

    // 2. Buffer Cache Miss
    this.diskReadCounts++;
    let page = this.memoryDisk.get(pageId);
    if (!page) {
      // If page does not exist on disk, we create one as an empty free data page
      this.log("STORAGE", "WARNING", `Page [${pageId}] not found on disk. Allocating new raw page.`);
      page = this.createEmptyPage(pageId, PageType.DATA);
      this.memoryDisk.set(pageId, page);
      this.totalPages = Math.max(this.totalPages, pageId + 1);
    }

    this.log("CACHE", "WARNING", `Buffer Pool MISS on Page [${pageId}]. Reading from disk file...`);
    
    // Evict a page if cache limit reached
    if (this.bufferPool.size >= this.bufferPoolSize) {
      this.evictBufferPage();
    }

    this.bufferPool.set(pageId, page);
    this.bufferLruQueue.push(pageId);
    return page;
  }

  // Update page inside the Buffer Pool (marks as dirty)
  public writePage(pageId: number, pageContent: Page) {
    pageContent.header.tx_lsn = Date.now(); // Simulating changing Log Sequence Number
    this.bufferPool.set(pageId, pageContent);
    this.updateLruQueue(pageId);
    
    // Simulating dirty state
    this.log("CACHE", "SUCCESS", `Page [${pageId}] marked DIRTY in buffer pool cache.`);
    
    // We synchronize automatically for minor interactions, but during crash testing, it remains dirty!
    // In our engine, we will let users explicitly click "FSYNC/Checkpoint" or write it out depending on WAL state
  }

  // Forces writing buffer page to disk directly
  public flushPageToDisk(pageId: number) {
    const page = this.bufferPool.get(pageId);
    if (page) {
      this.memoryDisk.set(pageId, JSON.parse(JSON.stringify(page)));
      this.diskWriteCounts++;
      this.log("STORAGE", "SUCCESS", `FLUSH: Page [${pageId}] written to disk file.`);
    }
  }

  private evictBufferPage() {
    const evictId = this.bufferLruQueue.shift();
    if (evictId !== undefined) {
      const pageToEvict = this.bufferPool.get(evictId);
      if (pageToEvict) {
        // Safe copy back to main storage representing physical disk file write-back
        this.memoryDisk.set(evictId, JSON.parse(JSON.stringify(pageToEvict)));
        this.diskWriteCounts++;
        this.bufferPool.delete(evictId);
        this.log("CACHE", "WARNING", `CACHE FULL: Evicted Page [${evictId}] from buffer pool. Dirty state flushed to physical persistent. Disk Write complete.`);
      }
    }
  }

  private updateLruQueue(pageId: number) {
    this.bufferLruQueue = this.bufferLruQueue.filter((id) => id !== pageId);
    this.bufferLruQueue.push(pageId);
  }

  // Allocates a new empty page and returns it
  public allocateNewPage(type: PageType, tableName?: string): Page {
    const newId = this.totalPages;
    this.totalPages++;
    const page = this.createEmptyPage(newId, type, tableName);
    this.memoryDisk.set(newId, page);
    
    this.log("STORAGE", "SUCCESS", `Allocating new physical page: Page [${newId}] (${type}) for ${tableName || "GENERAL"}`);
    
    // Load it into buffer pool immediately
    if (this.bufferPool.size >= this.bufferPoolSize) {
      this.evictBufferPage();
    }
    this.bufferPool.set(newId, page);
    this.bufferLruQueue.push(newId);
    
    return page;
  }

  public getPageCount(): number {
    return this.totalPages;
  }

  public getAllPages(): Page[] {
    // Fill pages that aren't loaded in RAM from disk
    const pages: Page[] = [];
    for (let i = 0; i < this.totalPages; i++) {
      pages.push(this.getPage(i));
    }
    return pages;
  }

  private createEmptyPage(pageId: number, type: PageType, tableName?: string): Page {
    return {
      header: {
        page_id: pageId,
        page_type: type,
        tx_lsn: 0,
        slot_count: 0,
        free_space_pointer: 4096, // A standard database page is 4096 bytes. Slotted-page expands payload from bottom (4096) and slot array from top (header ends at let's say 48 bytes)
      },
      slots: [],
      payloadSize: 0,
      rows: [],
      tableName,
      btree: type === PageType.INDEX_BTREE ? {
        isLeaf: true,
        keys: [],
        children: [],
        parent: null,
      } : undefined,
    };
  }

  // Database Bootstrap
  private initializeDefaultDatabase() {
    this.log("STORAGE", "WARNING", "Bootstrapping empty Aureum Database Engine files...");
    
    this.memoryDisk.clear();
    this.bufferPool.clear();
    this.bufferLruQueue = [];
    this.totalPages = 0;

    // 1. Page 0 is the METADATA Page. Stores Schemas & Db configs
    const page0 = this.createEmptyPage(0, PageType.METADATA);
    
    const schemas: TableSchema[] = [
      {
        name: "customers",
        primaryKey: "id",
        columns: [
          { name: "id", type: DataType.INTEGER, isPrimaryKey: true },
          { name: "name", type: DataType.STRING },
          { name: "country", type: DataType.STRING },
          { name: "active", type: DataType.BOOLEAN },
          { name: "balance", type: DataType.FLOAT },
        ],
        indices: [
          { name: "idx_cust_id", columns: ["id"], type: "B-TREE" },
          { name: "idx_cust_country", columns: ["country"], type: "HASH" },
        ],
      },
      {
        name: "orders",
        primaryKey: "id",
        columns: [
          { name: "id", type: DataType.INTEGER, isPrimaryKey: true },
          { name: "customer_id", type: DataType.INTEGER },
          { name: "amount", type: DataType.FLOAT },
          { name: "created_at", type: DataType.STRING },
        ],
        indices: [
          { name: "idx_ord_id", columns: ["id"], type: "B-TREE" },
        ],
      },
    ];

    // Store schemas in rows placeholder for Page 0
    page0.rows = [
      {
        id: "schema_customers",
        tx_created: 0,
        tx_expired: null,
        rollback_ptr: null,
        data: schemas[0] as any,
      },
      {
        id: "schema_orders",
        tx_created: 0,
        tx_expired: null,
        rollback_ptr: null,
        data: schemas[1] as any,
      },
    ];
    page0.header.slot_count = 2;
    page0.header.free_space_pointer = 4096 - 2 * 256; // Mock slots allocation

    this.memoryDisk.set(0, page0);
    this.totalPages = 1;

    // 2. Allocate data page for Customers (Page 1)
    const page1 = this.allocateNewPage(PageType.DATA, "customers");
    const testCustomers = [
      { id: 101, name: "Alice Vance", country: "USA", active: true, balance: 1250.50 },
      { id: 102, name: "Marcus Aurelius", country: "Italy", active: true, balance: 4200.00 },
      { id: 103, name: "Sophie Dupont", country: "France", active: false, balance: 15.20 },
      { id: 104, name: "Hiroshi Tanaka", country: "Japan", active: true, balance: 890.30 },
      { id: 105, name: "Isabella Smith", country: "USA", active: true, balance: 250.00 },
    ];

    testCustomers.forEach((cust, i) => {
      const rowSize = JSON.stringify(cust).length; // Simulated layout in bytes
      const slot: PageSlot = {
        offset: page1.header.free_space_pointer - rowSize,
        length: rowSize,
      };
      page1.header.free_space_pointer = slot.offset;
      page1.header.slot_count++;
      page1.slots.push(slot);
      page1.rows.push({
        id: `cust_${cust.id}`,
        tx_created: 0,
        tx_expired: null,
        rollback_ptr: null,
        data: cust,
      });
    });
    this.writePage(1, page1);

    // 3. Allocate data page for Orders (Page 2)
    const page2 = this.allocateNewPage(PageType.DATA, "orders");
    const testOrders = [
      { id: 501, customer_id: 101, amount: 250.00, created_at: "2026-05-01 10:00:00" },
      { id: 502, customer_id: 101, amount: 1000.50, created_at: "2026-05-15 11:30:00" },
      { id: 503, customer_id: 102, amount: 4200.00, created_at: "2026-05-20 14:00:00" },
      { id: 504, customer_id: 104, amount: 500.00, created_at: "2026-06-01 09:12:00" },
      { id: 505, customer_id: 104, amount: 390.30, created_at: "2026-06-02 17:45:00" },
    ];

    testOrders.forEach((order) => {
      const rowSize = JSON.stringify(order).length;
      const slot: PageSlot = {
        offset: page2.header.free_space_pointer - rowSize,
        length: rowSize,
      };
      page2.header.free_space_pointer = slot.offset;
      page2.header.slot_count++;
      page2.slots.push(slot);
      page2.rows.push({
        id: `order_${order.id}`,
        tx_created: 0,
        tx_expired: null,
        rollback_ptr: null,
        data: order,
      });
    });
    this.writePage(2, page2);

    // 4. Allocate Index pages (Page 3 for B-Tree customers index, Page 4 for customers country hash index, Page 5 for B-Tree orders index)
    const idxPage3 = this.allocateNewPage(PageType.INDEX_BTREE, "customers");
    idxPage3.btree = {
      isLeaf: true,
      keys: ["101", "102", "103", "104", "105"],
      children: [1, 1, 1, 1, 1], // In standard simple B-Tree: points to rows inside page 1
      parent: null,
    };
    idxPage3.header.slot_count = 5;
    this.writePage(3, idxPage3);

    const idxPage4 = this.allocateNewPage(PageType.INDEX_HASH, "customers");
    idxPage4.rows = [
      { id: "hash_usa", tx_created: 0, tx_expired: null, rollback_ptr: null, data: { key: "USA", page_ids: [1] } },
      { id: "hash_it", tx_created: 0, tx_expired: null, rollback_ptr: null, data: { key: "Italy", page_ids: [1] } },
      { id: "hash_fr", tx_created: 0, tx_expired: null, rollback_ptr: null, data: { key: "France", page_ids: [1] } },
      { id: "hash_jp", tx_created: 0, tx_expired: null, rollback_ptr: null, data: { key: "Japan", page_ids: [1] } },
    ];
    idxPage4.header.slot_count = 4;
    this.writePage(4, idxPage4);

    const idxPage5 = this.allocateNewPage(PageType.INDEX_BTREE, "orders");
    idxPage5.btree = {
      isLeaf: true,
      keys: ["501", "502", "503", "504", "505"],
      children: [2, 2, 2, 2, 2], // page 2
      parent: null,
    };
    idxPage5.header.slot_count = 5;
    this.writePage(5, idxPage5);

    this.log("STORAGE", "SUCCESS", "Database bootstrapped with core schemas, visual pages, default datasets, and loaded B-Tree/Hash Indexes.");
    
    // Save to disk initially
    this.syncToDisk();
  }
}
