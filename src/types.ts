/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

export enum DataType {
  INTEGER = "INTEGER",
  FLOAT = "FLOAT",
  BOOLEAN = "BOOLEAN",
  STRING = "STRING",
  DATETIME = "DATETIME",
  BINARY_BLOB = "BINARY_BLOB",
  JSON = "JSON",
}

export interface Column {
  name: string;
  type: DataType;
  isNullable?: boolean;
  isPrimaryKey?: boolean;
}

export interface TableSchema {
  name: string;
  columns: Column[];
  primaryKey: string;
  indices: {
    name: string;
    columns: string[];
    type: "B-TREE" | "HASH";
  }[];
}

export type DbValue = number | string | boolean | null | Record<string, any>;

export interface Row {
  // MVCC metadata
  tx_created: number;
  tx_expired: number | null;
  rollback_ptr: string | null; // ID of the cloned older version if available
  id: string; // Unique row version identifier
  data: Record<string, DbValue>;
}

// Low-level Storage representation
export enum PageType {
  METADATA = "METADATA",
  DATA = "DATA",
  INDEX_BTREE = "INDEX_BTREE",
  INDEX_HASH = "INDEX_HASH",
  FREE_LIST = "FREE_LIST",
}

export interface PageHeader {
  page_id: number;
  page_type: PageType;
  tx_lsn: number; // Log Sequence Number
  slot_count: number;
  free_space_pointer: number; // Offset byte index where free space starts in slot-structured layout
}

export interface PageSlot {
  offset: number;
  length: number;
}

export interface Page {
  header: PageHeader;
  slots: PageSlot[];
  // Raw representation as ArrayBuffer, or a rich mock representing bytes
  payloadSize: number; // size in bytes currently written
  rows: Row[]; // deserialized data rows for DATA page, or keys for INDEX page
  tableName?: string;
  // B-Tree specific fields for easy visualization
  btree?: {
    isLeaf: boolean;
    keys: string[]; // key representation as string
    children: number[]; // Child page IDs
    parent: number | null;
  };
}

// WAL & Transactions
export enum TxStatus {
  ACTIVE = "ACTIVE",
  COMMITTED = "COMMITTED",
  ABORTED = "ABORTED",
}

export interface Transaction {
  id: number;
  status: TxStatus;
  startedAt: string;
  isolationLevel: "READ_COMMITTED" | "SERIALIZABLE";
  touchedRows: { tableName: string; rowId: string; prevVersionId: string | null }[];
}

export enum LogType {
  BEGIN = "BEGIN",
  INSERT = "INSERT",
  UPDATE = "UPDATE",
  DELETE = "DELETE",
  COMMIT = "COMMIT",
  ABORT = "ABORT",
}

export interface LogRecord {
  lsn: number;
  tx_id: number;
  type: LogType;
  tableName?: string;
  rowId?: string;
  beforeImage?: Record<string, DbValue>;
  afterImage?: Record<string, DbValue>;
  timestamp: string;
}

// Query Executor
export type PlanNode_Type =
  | "SEQ_SCAN"
  | "INDEX_SCAN"
  | "FILTER"
  | "JOIN"
  | "PROJECT"
  | "ORDER_BY"
  | "LIMIT";

export interface PlanNode {
  type: PlanNode_Type;
  cost: number;
  estimatedRows: number;
  details: string;
  children: PlanNode[];
}

export interface ExecutionResult {
  success: boolean;
  message: string;
  rows?: Record<string, DbValue>[];
  plan?: PlanNode;
  affectedRows?: number;
  logs: LogMessage[];
}

export interface LogMessage {
  timestamp: string;
  module: "STORAGE" | "QUERY" | "TX" | "INDEX" | "WAL" | "CACHE" | "NET" | "CLI";
  level: "INFO" | "WARNING" | "ERROR" | "SUCCESS";
  message: string;
}

export interface DBMetadata {
  name: string;
  version: string;
  created_at: string;
  page_size: number;
  total_pages: number;
  wal_active: boolean;
}
