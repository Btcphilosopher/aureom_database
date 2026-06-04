/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import React, { useState, useEffect, useRef } from "react";
import { 
  Database, 
  Terminal as TerminalIcon, 
  Layers, 
  GitBranch, 
  Clock, 
  FileText, 
  Play, 
  Zap, 
  RefreshCw, 
  Trash2, 
  Compass, 
  Cpu, 
  AlertTriangle,
  CheckCircle,
  HelpCircle,
  Info
} from "lucide-react";
import { motion, AnimatePresence } from "motion/react";
import { AureumDatabase } from "./engine/database";
import { DataType, PageType, Row, Page, LogRecord, PlanNode, ExecutionResult, LogMessage, TableSchema } from "./types";

export default function App() {
  const [db, setDb] = useState<AureumDatabase | null>(null);
  const [sqlCommand, setSqlCommand] = useState("");
  const [activeTab, setActiveTab] = useState<"disk" | "index" | "mvcc" | "wal" | "plan">("disk");
  const [selectedPageId, setSelectedPageId] = useState<number | null>(0);
  const [lastQueryResult, setLastQueryResult] = useState<ExecutionResult | null>(null);
  
  // Terminal log stream
  const [terminalHistory, setTerminalHistory] = useState<{ query: string; result: ExecutionResult }[]>([]);
  
  // Real-time system state monitoring
  const [pagesList, setPagesList] = useState<Page[]>([]);
  const [dbStats, setDbStats] = useState({ diskWrites: 0, diskReads: 0, hitRate: 100, cachedPages: [] as number[] });
  const [activeTxs, setActiveTxs] = useState<any[]>([]);
  const [walLogs, setWalLogs] = useState<LogRecord[]>([]);
  const [schemasList, setSchemasList] = useState<TableSchema[]>([]);

  // Recovery dialog logs
  const [recoveryLogList, setRecoveryLogList] = useState<string[]>([]);
  const [showRecoveryLogs, setShowRecoveryLogs] = useState(false);
  const [recoveredCount, setRecoveredCount] = useState({ replayed: 0, undone: 0 });

  const terminalEndRef = useRef<HTMLDivElement>(null);

  // Initialize DB on boot
  useEffect(() => {
    const initializedDb = new AureumDatabase();
    setDb(initializedDb);
    setPagesList(initializedDb.storage.getAllPages());
    setDbStats(initializedDb.storage.getDiskStats());
    setActiveTxs(initializedDb.tx.getActiveTransactions());
    setWalLogs(initializedDb.wal.getWALRecords());
    setSchemasList(initializedDb.getSchemas());
    
    // Check if recovery is needed (i.e. did we crash in previous run, leaving pending logs in WAL)
    const walLength = initializedDb.wal.getWALRecords().length;
    if (walLength > 0) {
      initializedDb.storage.log("WAL", "WARNING", "System boot detected pending transaction stream in Write-Ahead Log. Initiating crash recovery sequence.");
    }
  }, []);

  // Update frontend state variables helper
  const syncState = (dbInstance: AureumDatabase) => {
    setPagesList(dbInstance.storage.getAllPages());
    setDbStats(dbInstance.storage.getDiskStats());
    setActiveTxs(dbInstance.tx.getActiveTransactions());
    setWalLogs(dbInstance.wal.getWALRecords());
    setSchemasList(dbInstance.getSchemas());
  };

  // SQL console execution pipeline
  const handleExecuteSql = (cmdText: string) => {
    if (!db || !cmdText.trim()) return;

    const res = db.executeQuery(cmdText);
    setLastQueryResult(res);
    setTerminalHistory((prev) => [...prev, { query: cmdText, result: res }]);
    
    syncState(db);
    setSqlCommand("");
    
    // Auto-scroll terminal logs
    setTimeout(() => {
      terminalEndRef.current?.scrollIntoView({ behavior: "smooth" });
    }, 50);
  };

  // Run ARIES recovery loader
  const triggerARIESRecovery = () => {
    if (!db) return;
    
    const recoveryResult = db.bootRecovery();
    setRecoveryLogList(recoveryResult.logs);
    setRecoveredCount({ replayed: recoveryResult.replayedCount, undone: recoveryResult.undoneCount });
    setShowRecoveryLogs(true);
    
    syncState(db);
  };

  // Power loss tester (immediate volatile RAM dump)
  const triggerVolatileCrash = () => {
    if (!db) return;
    db.storage.triggerCrash();
    
    // Reset volatile states
    db.activeTxId = null;
    
    syncState(db);
    db.storage.log("TX", "ERROR", "CRASH REGISTERED. Volatile Buffer Cache pool dumped. Disk files left inconsistent.");
    
    setLastQueryResult({
      success: false,
      message: "POWER OUTAGE SIMULATED: Volatile RAM Cache pool deleted. Please run recovery to restore ACID consistency.",
      logs: [{
        timestamp: new Date().toLocaleTimeString(),
        module: "STORAGE",
        level: "ERROR",
        message: "SYSTEM TERMINATION WITHOUT SYNC. Perform recovery.",
      }]
    });
  };

  // Soft checkpoint dump (write dirty pages to visual files disk)
  const triggerForceCheckpoint = () => {
    if (!db) return;
    db.storage.syncToDisk();
    syncState(db);
    
    setLastQueryResult({
      success: true,
      message: "CHECKPOINT COMPLETE: Synced all transient buffer pool pages to disk storage files.",
      logs: [{
        timestamp: new Date().toLocaleTimeString(),
        module: "STORAGE",
        level: "SUCCESS",
        message: "Volatile Page Matrix successfully written to persistent localStorage.",
      }]
    });
  };

  // Database complete wipeout
  const handleDatabaseReset = () => {
    if (!db) return;
    if (confirm("Are you sure you want to completely erase the database pages and log records?")) {
      db.wipeAll();
      syncState(db);
      setTerminalHistory([]);
      setSelectedPageId(0);
      setLastQueryResult(null);
    }
  };

  const sqlTemplates = [
    { name: "Fetch Customers", sql: "SELECT * FROM customers;" },
    { name: "USA Customers (Index)", sql: "SELECT * FROM customers WHERE country = 'USA';" },
    { name: "Insert Customer (Implicit Tx)", sql: "INSERT INTO customers (id, name, country, active, balance) VALUES (106, 'Julius Caesar', 'Italy', true, 5500.00);" },
    { name: "Select Active Joined", sql: "SELECT * FROM customers JOIN orders ON customers.id = orders.customer_id WHERE active = true;" },
    { name: "Begin Explicit Tx", sql: "BEGIN TRANSACTION READ_COMMITTED;" },
    { name: "Update Balance", sql: "UPDATE customers SET balance = 8000.00 WHERE id = 101;" },
    { name: "Commit Tx", sql: "COMMIT;" },
    { name: "Rollback Tx", sql: "ROLLBACK;" },
  ];

  const selectedPage = pagesList.find(p => p.header.page_id === selectedPageId) || pagesList[0];

  return (
    <div id="app_root" className="min-h-screen bg-[#0A0A0A] text-[#E0E0E0] font-sans flex flex-col antialiased selection:bg-[#D4AF37]/30 selection:text-white md:border-8 md:border-[#1A1A1A]">
      
      {/* Visual Top Bar Header - Editorial Aesthetic */}
      <header className="p-8 md:p-12 pb-6 flex flex-col md:flex-row justify-between items-start md:items-baseline border-b border-[#222] gap-6 bg-[#0A0A0A]">
        <div>
          <h1 className="text-5xl md:text-7xl font-serif font-black tracking-tighter text-[#D4AF37] leading-none">
            AUREUM
          </h1>
          <p className="text-xs tracking-[0.4em] uppercase opacity-60 mt-3 font-mono">
            Database Kernel // v1.0.0-alpha • Rust-Spec Emulation
          </p>
        </div>
        <div className="flex flex-col items-start md:items-end gap-3 shrink-0">
          <span className="inline-block px-3 py-1 border border-[#D4AF37] text-[#D4AF37] text-[10px] font-bold uppercase tracking-widest bg-[#D4AF37]/5">
            Rust Native Emulation
          </span>
          <p className="text-xs text-zinc-400 italic font-serif">
            Slotted-Page Storage • B-Tree Indexing • MVCC • ARIES Recovery
          </p>
        </div>
      </header>

      {/* Global DB Diagnostics metrics strip - Editorial Layout */}
      <div className="border-b border-[#222] bg-[#0F0F0F] px-8 md:px-12 py-4 flex flex-wrap items-center justify-between gap-4 text-xs font-mono">
        <div className="flex items-center gap-2 text-[10px] uppercase tracking-widest text-[#D4AF37]">
          <span className="w-1.5 h-1.5 bg-[#D4AF37] rotate-45 animate-pulse"></span>
          System Status: Operational
        </div>
        <div className="flex flex-wrap items-center gap-2 md:gap-4">
          <div className="bg-[#0A0A0A] border border-[#222] px-3.5 py-1.5 flex items-center gap-2">
            <Layers className="w-3.5 h-3.5 text-[#D4AF37]" />
            <span className="text-zinc-500">Pages:</span>
            <span className="text-white font-bold">{pagesList.length}</span>
          </div>
          <div className="bg-[#0A0A0A] border border-[#222] px-3.5 py-1.5 flex items-center gap-2">
            <Cpu className="w-3.5 h-3.5 text-[#D4AF37]" />
            <span className="text-zinc-500">Cache Stats:</span>
            <span className="text-white font-bold">{(dbStats.diskReads - dbStats.diskWrites > 0) ? `${dbStats.hitRate}%` : "100%"}</span>
          </div>
          <div className="bg-[#0A0A0A] border border-[#222] px-3.5 py-1.5 flex items-center gap-2">
            <Clock className="w-3.5 h-3.5 text-[#D4AF37]" />
            <span className="text-zinc-500">Active Tx:</span>
            <span className={db?.activeTxId ? "text-amber-500 font-bold" : "text-zinc-400"}>
              {db?.activeTxId ? `[${db.activeTxId}]` : "None"}
            </span>
          </div>
          <div className="bg-[#0A0A0A] border border-[#222] px-3.5 py-1.5 flex items-center gap-2">
            <FileText className="w-3.5 h-3.5 text-[#D4AF37]" />
            <span className="text-zinc-500">WAL Logs:</span>
            <span className="text-white font-bold">{walLogs.length}</span>
          </div>
        </div>
      </div>

      {/* Main Grid Workspace divided cleanly by subtle borders */}
      <main className="flex-1 grid grid-cols-1 lg:grid-cols-12 gap-0 w-full bg-[#0A0A0A]">
        
        {/* LEFT COLUMN: SQL Console & Actions Playgrounds */}
        <div className="col-span-1 lg:col-span-5 flex flex-col gap-8 p-8 md:p-12 bg-[#0F0F0F] border-b lg:border-b-0 lg:border-r border-[#222]">

          {/* Database System Stress Testing Suite */}
          <section id="control-panel" className="bg-[#141414] border border-[#222] p-6 flex flex-col gap-4">
            <div className="flex justify-between items-baseline">
              <h2 className="text-xs font-mono font-bold tracking-[0.2em] uppercase text-[#D4AF37] flex items-center gap-2">
                <Zap className="w-3.5 h-3.5 text-[#D4AF37]" />
                Fault Injection & Synced Checkpoints
              </h2>
            </div>
            <p className="text-xs text-zinc-400 italic font-serif leading-relaxed">
              Designed for deterministic performance, transactional integrity, and memory safety without compromise. Force buffer pool states or simulate power failures.
            </p>
            <div className="grid grid-cols-2 gap-2.5 mt-1">
              <button
                id="btn-crash-engine"
                onClick={triggerVolatileCrash}
                className="flex items-center justify-center gap-2 px-3.5 py-2.5 text-xs font-mono font-bold bg-[#281515] border border-red-950 text-red-400 hover:bg-red-950/80 active:scale-[0.98] transition-all cursor-pointer"
                title="Wipes volatile pool cache immediately simulating power loss"
              >
                <AlertTriangle className="w-3.5 h-3.5 text-red-500 animate-pulse" />
                CRASH ENGINE
              </button>
              <button
                id="btn-aries-recovery"
                onClick={triggerARIESRecovery}
                className="flex items-center justify-center gap-2 px-3.5 py-2.5 text-xs font-mono font-bold bg-[#D4AF37] text-black hover:bg-[#c29d2b] active:scale-[0.98] transition-all cursor-pointer"
                title="Runs dynamic log replay and undo on catalog pages"
              >
                <RefreshCw className="w-3.5 h-3.5 font-bold" />
                ARIES RECOVERY
              </button>
              <button
                id="btn-force-checkpoint"
                onClick={triggerForceCheckpoint}
                className="flex items-center justify-center gap-2 px-3.5 py-2.5 text-xs font-mono font-bold bg-[#0A0A0A] border border-[#222] text-zinc-300 hover:bg-[#141414] active:scale-[0.98] transition-all cursor-pointer"
                title="Commits buffer pages to standard simulated storage file"
              >
                <CheckCircle className="w-3.5 h-3.5 text-[#D4AF37]" />
                FSYNC CHECKPOINT
              </button>
              <button
                id="btn-wipe-database"
                onClick={handleDatabaseReset}
                className="flex items-center justify-center gap-2 px-3.5 py-2.5 text-xs font-mono font-bold bg-[#0A0A0A] border border-[#222] text-zinc-500 hover:text-red-400 hover:border-red-900/50 active:scale-[0.98] transition-all cursor-pointer"
                title="Erases database files fully"
              >
                <Trash2 className="w-3.5 h-3.5" />
                WIPE ALL DATA
              </button>
            </div>
          </section>

          {/* Interactive Shell Terminal Console */}
          <section id="terminal-section" className="bg-[#0A0A0A] border border-[#222] flex flex-col min-h-[380px] lg:min-h-[460px]">
            <div className="bg-[#141414] px-5 py-3 border-b border-[#222] flex items-center justify-between">
              <div className="flex items-center gap-2 text-xs font-mono font-bold uppercase tracking-wider text-zinc-350">
                <TerminalIcon className="w-3.5 h-3.5 text-[#D4AF37]" />
                Interactive SQL console
              </div>
              <div className="flex items-center gap-1.5 text-[9px] font-mono text-[#D4AF37]">
                <span className="w-1.5 h-1.5 bg-[#D4AF37] rotate-45 animate-pulse"></span>
                ONLINE
              </div>
            </div>

            {/* CRT styled log terminal history screen */}
            <div className="flex-1 p-5 overflow-y-auto space-y-4 max-h-[300px] font-mono text-xs">
              <div className="text-zinc-500 italic select-none">Aureum Kernel Shell mode active. Type queries or use templated actions.</div>
              
              {terminalHistory.map((h, idx) => (
                <div key={idx} className="space-y-2 border-b border-[#1A1A1A] pb-3">
                  <div className="text-[#D4AF37] flex items-start gap-1 font-bold">
                    <span className="text-zinc-650 font-bold select-none">&gt;</span>
                    <span>{h.query}</span>
                  </div>
                  
                  {h.result.success ? (
                    <div className="text-zinc-300 bg-[#0F0F0F] rounded-0 p-3 border border-[#222]">
                      <div className="text-[9px] text-[#D4AF37] font-mono uppercase tracking-widest font-bold mb-1.5">SUCCESS</div>
                      <div className="text-[11px] font-sans text-zinc-350 font-semibold mb-2">{h.result.message}</div>
                      
                      {/* Render rows visual table if SELECT was triggered */}
                      {h.result.rows && h.result.rows.length > 0 && (
                        <div className="mt-2.5 overflow-x-auto border border-[#222] bg-[#0A0A0A]">
                          <table className="w-full text-left text-[11px] font-mono border-collapse">
                            <thead>
                              <tr className="bg-[#141414] border-b border-[#222]">
                                {Object.keys(h.result.rows[0]).map((col) => (
                                  <th key={col} className="px-2 py-1.5 font-bold uppercase text-[9px] text-zinc-400 border-r border-[#222] last:border-r-0 tracking-wider">
                                    {col}
                                  </th>
                                ))}
                              </tr>
                            </thead>
                            <tbody>
                              {h.result.rows.map((row, rowIdx) => (
                                <tr key={rowIdx} className="border-b border-[#1A1A1A] last:border-b-0 hover:bg-[#141414]">
                                  {Object.values(row).map((val, cellIdx) => (
                                    <td key={cellIdx} className="px-2 py-1.5 text-zinc-300 border-r border-[#1A1A1A] last:border-r-0 truncate max-w-[120px]">
                                      {val === null ? (
                                        <span className="text-zinc-600 font-bold">NULL</span>
                                      ) : typeof val === "boolean" ? (
                                        <span className={val ? "text-emerald-500 font-bold" : "text-red-500 font-bold"}>{val ? "TRUE" : "FALSE"}</span>
                                      ) : typeof val === "object" ? (
                                        JSON.stringify(val)
                                      ) : (
                                        String(val)
                                      )}
                                    </td>
                                  ))}
                                </tr>
                              ))}
                            </tbody>
                          </table>
                        </div>
                      )}
                    </div>
                  ) : (
                    <div className="text-red-400 bg-red-950/10 border border-red-900/40 p-3 text-[11px] font-mono leading-relaxed">
                      <div className="font-bold text-red-500 mb-1.5 uppercase tracking-wide">EVALUATION ERROR:</div>
                      <div>{h.result.message}</div>
                    </div>
                  )}

                  {/* Engine log steps details toggled inside terminal result */}
                  {h.result.logs.length > 0 && (
                    <div className="mt-2 text-[10px] space-y-1 text-zinc-500 pl-3 border-l-2 border-[#D4AF37]/50">
                      {h.result.logs.map((log, lIdx) => (
                        <div key={lIdx} className="flex gap-2">
                          <span className="text-zinc-650 shrink-0 select-none">{log.timestamp}</span>
                          <span className={`font-semibold shrink-0 uppercase tracking-widest text-[9px] ${
                            log.level === "ERROR" ? "text-red-500" :
                            log.level === "WARNING" ? "text-amber-500" :
                            log.level === "SUCCESS" ? "text-emerald-500" : "text-zinc-400"
                          }`}>[{log.module}]</span>
                          <span className="truncate">{log.message}</span>
                        </div>
                      ))}
                    </div>
                  )}
                </div>
              ))}
              
              <div ref={terminalEndRef} />
            </div>

            {/* SQL Terminal direct form controller */}
            <form onSubmit={(e) => { e.preventDefault(); handleExecuteSql(sqlCommand); }} className="border-t border-[#222] bg-[#141414] p-3 flex gap-2">
              <input
                id="input-sql-console"
                type="text"
                value={sqlCommand}
                onChange={(e) => setSqlCommand(e.target.value)}
                placeholder="SELECT * FROM customers WHERE balance > 1000;"
                className="flex-1 bg-[#0A0A0A] text-zinc-105 placeholder-zinc-700 px-3 py-2 text-xs font-mono rounded-0 border border-[#222] focus:outline-none focus:border-[#D4AF37] transition-colors"
                autoComplete="off"
              />
              <button
                type="submit"
                className="px-4 py-2 font-mono text-xs font-bold bg-[#D4AF37] text-black cursor-pointer hover:bg-[#bda03c] active:bg-[#aa8d32] flex items-center gap-1.5 shrink-0 transition-colors"
              >
                <Play className="w-3 h-3 fill-current shrink-0" />
                EXECUTE
              </button>
            </form>
          </section>

          {/* Quick SQL Execution Templates panel */}
          <section id="table-templates" className="bg-[#141414] border border-[#222] p-6 flex flex-col gap-3">
            <h3 className="text-xs font-semibold text-zinc-400 uppercase tracking-widest flex items-center gap-2 mb-1">
              <Compass className="w-3.5 h-3.5 text-[#D4AF37]" />
              SQL Template Library
            </h3>
            <p className="text-[11px] text-zinc-500 italic font-serif leading-relaxed">
              Load and immediately evaluate dynamic schemas, indexing commands, insertion transactions, or joins.
            </p>
            <div className="grid grid-cols-2 gap-2 mt-1">
              {sqlTemplates.map((item, idx) => (
                <button
                  key={idx}
                  onClick={() => {
                    setSqlCommand(item.sql);
                    handleExecuteSql(item.sql);
                  }}
                  className="px-3 py-2.5 text-left text-[11px] font-mono rounded-0 bg-[#0A0A0A] hover:bg-[#141414] border border-[#222] hover:border-[#D4AF37] text-zinc-400 hover:text-[#D4AF37] transition-all text-ellipsis overflow-hidden whitespace-nowrap cursor-pointer font-semibold"
                >
                  {item.name}
                </button>
              ))}
            </div>
          </section>

        </div>

        {/* RIGHT COLUMN: Physical Layout Inspectors Dashboard */}
        <div className="col-span-1 lg:col-span-7 flex flex-col gap-6 p-8 md:p-12 bg-[#0A0A0A]">
          
          {/* Diagnostic tab selection bar - Editorial layout */}
          <div className="flex border-b border-[#222] gap-1 overflow-x-auto text-[11px] font-mono uppercase tracking-wider select-none">
            <button
              id="tab-disk"
              onClick={() => setActiveTab("disk")}
              className={`px-4 py-2.5 font-bold border-b-2 transition-colors cursor-pointer ${
                activeTab === "disk" ? "border-[#D4AF37] text-[#D4AF37]" : "border-transparent text-zinc-500 hover:text-zinc-300"
              }`}
            >
              Disk Page Map
            </button>
            <button
              id="tab-index"
              onClick={() => setActiveTab("index")}
              className={`px-4 py-2.5 font-bold border-b-2 transition-colors cursor-pointer ${
                activeTab === "index" ? "border-[#D4AF37] text-[#D4AF37]" : "border-transparent text-zinc-500 hover:text-zinc-300"
              }`}
            >
              B-Tree & Hash
            </button>
            <button
              id="tab-mvcc"
              onClick={() => setActiveTab("mvcc")}
              className={`px-4 py-2.5 font-bold border-b-2 transition-colors cursor-pointer ${
                activeTab === "mvcc" ? "border-[#D4AF37] text-[#D4AF37]" : "border-transparent text-zinc-500 hover:text-zinc-300"
              }`}
            >
              MVCC Versions
            </button>
            <button
              id="tab-wal"
              onClick={() => setActiveTab("wal")}
              className={`px-4 py-2.5 font-bold border-b-2 transition-colors cursor-pointer ${
                activeTab === "wal" ? "border-[#D4AF37] text-[#D4AF37]" : "border-transparent text-zinc-500 hover:text-zinc-300"
              }`}
            >
              WAL Log Stream
            </button>
            <button
              id="tab-plan"
              onClick={() => setActiveTab("plan")}
              className={`px-4 py-2.5 font-bold border-b-2 transition-colors cursor-pointer ${
                activeTab === "plan" ? "border-[#D4AF37] text-[#D4AF37]" : "border-transparent text-zinc-500 hover:text-zinc-300"
              }`}
            >
              Query Plan Tree
            </button>
          </div>

          {/* TAB CONTENTS PANEL - Editorial Aesthetic */}
          <section className="bg-[#0F0F0F] border border-[#222] p-6 flex-1 min-h-[460px] flex flex-col justify-between">
            <AnimatePresence mode="wait">
              
              {/* 1. DISK PAGES TAB */}
              {activeTab === "disk" && (
                <motion.div
                  key="disk_tab"
                  initial={{ opacity: 0, y: 10 }}
                  animate={{ opacity: 1, y: 0 }}
                  exit={{ opacity: 0, y: -10 }}
                  className="flex flex-col gap-5 flex-1 justify-start h-full"
                >
                  <div className="flex flex-col gap-1.5">
                    <h3 className="text-xl md:text-2xl font-serif font-bold text-[#D4AF37] tracking-tight">
                      Slotted-Page Memory Allocation
                    </h3>
                    <p className="text-xs text-zinc-400 font-sans italic">
                      Interactive layout representing physical segments. Aureum DB schedules files in rigorous 4KB pages. Click a segment block below to inspect its slotted-page cell allocations.
                    </p>
                  </div>

                  {/* Allocated pages block matrix */}
                  <div className="grid grid-cols-3 sm:grid-cols-6 lg:grid-cols-4 xl:grid-cols-6 gap-3 pt-2">
                    {pagesList.map((p) => {
                      const isSelected = p.header.page_id === selectedPageId;
                      const isCached = dbStats.cachedPages.includes(p.header.page_id);
                      
                      let colorClass = "bg-[#0A0A0A] border-[#222] text-zinc-500 hover:border-zinc-400";
                      if (p.header.page_type === PageType.METADATA) {
                        colorClass = "bg-[#141414] border-2 border-[#D4AF37] text-[#D4AF37]";
                      } else if (p.header.page_type === PageType.DATA) {
                        colorClass = "bg-[#0A0A0A] border-2 border-[#222] hover:border-[#D4AF37] text-zinc-200";
                      } else if (p.header.page_type.startsWith("INDEX_")) {
                        colorClass = "bg-[#0A0A0A] border-2 border-emerald-900/60 text-emerald-400 hover:border-emerald-500";
                      } else if (p.header.page_type === PageType.FREE_LIST) {
                        colorClass = "bg-[#0A0A0A]/40 border-2 border-dashed border-[#222] text-zinc-650";
                      }

                      return (
                        <button
                          key={p.header.page_id}
                          onClick={() => setSelectedPageId(p.header.page_id)}
                          className={`relative p-3.5 rounded-none border font-mono text-left select-none text-xs flex flex-col justify-between transition-all aspect-square cursor-pointer min-h-[75px] ${colorClass} ${
                            isSelected ? "ring-2 ring-[#D4AF37] ring-offset-2 ring-offset-[#0A0A0A] scale-[1.03]" : ""
                          }`}
                        >
                          <div className="flex items-start justify-between w-full">
                            <span className="font-bold text-sm">#{p.header.page_id}</span>
                            {isCached && (
                              <span className="text-[8px] bg-[#D4AF37] text-black font-bold px-1 rounded-none transform scale-[0.95]">
                                RAM
                              </span>
                            )}
                          </div>
                          <div>
                            <div className="text-[9px] uppercase font-bold text-zinc-400 tracking-wider overflow-hidden text-ellipsis whitespace-nowrap mt-1">
                              {p.header.page_type.replace("INDEX_", "")}
                            </div>
                            <div className="text-[10px] text-zinc-500 truncate">
                              {p.tableName ? `[${p.tableName}]` : "SYSTEM"}
                            </div>
                          </div>
                        </button>
                      );
                    })}
                  </div>

                  {/* Slotted Page Binary Inspector */}
                  {selectedPage && (
                    <div className="mt-4 border border-[#222] bg-[#0A0A0A] p-5 space-y-4">
                      <div className="pb-3 border-b border-[#222] flex flex-col sm:flex-row justify-between items-start sm:items-center gap-2">
                        <div>
                          <div className="text-xs font-mono font-bold text-[#D4AF37] tracking-widest uppercase">
                            PAGE #{selectedPage.header.page_id} INSPECTOR / {selectedPage.header.page_type}
                          </div>
                          <div className="text-[11px] text-zinc-400 font-sans italic mt-1">
                            Table context: {selectedPage.tableName ? `"${selectedPage.tableName}"` : "Database Catalogs System metadata"}
                          </div>
                        </div>
                        <div className="text-[10px] bg-[#141414] border border-[#222] px-2.5 py-1 text-[#D4AF37] font-mono">
                          LSN offset LSN: {selectedPage.header.tx_lsn}
                        </div>
                      </div>

                      {/* Low-Level Slotted Page Representation (Slotted-Page Architecture) */}
                      <div className="grid grid-cols-1 md:grid-cols-12 gap-4">
                        
                        {/* Slotted page schematic representation */}
                        <div className="md:col-span-5 flex flex-col gap-2">
                          <span className="text-[10.5px] font-mono font-bold text-zinc-500 uppercase tracking-widest">
                            Slotted-Page Byte Blueprint (4096B)
                          </span>
                          <div className="border border-[#222] overflow-hidden font-mono text-[10px] h-[160px] flex flex-col justify-between bg-[#0A0A0A]">
                            {/* Page Header (Top Expansion) */}
                            <div className="bg-[#D4AF37]/5 border-b border-[#D4AF37]/15 p-2 text-[#D4AF37]">
                              <div className="font-bold flex justify-between">
                                <span>[0x00 - 0x2F] PAGE HEADER</span>
                                <span>48 bytes</span>
                              </div>
                              <div className="text-[9px] text-zinc-500">
                                page_id: {selectedPage.header.page_id} • free_ptr: {selectedPage.header.free_space_pointer}B • slots: {selectedPage.header.slot_count}
                              </div>
                            </div>

                            {/* Slot Array Index (Expands from top down) */}
                            <div className="bg-emerald-500/5 border-b border-emerald-950/20 p-2 text-emerald-400 flex-1">
                              <div className="font-semibold flex justify-between">
                                <span>[0x30 - 0xBF] SLOT ARRAY INDEX</span>
                                <span>{selectedPage.slots.length * 8} bytes</span>
                              </div>
                              <div className="flex flex-wrap gap-1 mt-1">
                                {selectedPage.slots.map((s, idx) => (
                                  <span key={idx} className="bg-[#141414] border border-[#222] px-1 py-0.5 text-zinc-400 text-[8px]" title={`Offset: ${s.offset}, Len: ${s.length}`}>
                                    S{idx}: {s.offset}B
                                  </span>
                                ))}
                                {selectedPage.slots.length === 0 && <span className="text-zinc-650 text-[9px]">No cells assigned</span>}
                              </div>
                            </div>

                            {/* Volatile space pointer indicator gap */}
                            <div className="p-1 border-b border-[#222] text-center text-[9px] text-zinc-650 bg-[#0A0A0A] flex justify-between px-2 font-bold font-mono">
                              <span>--- STORAGE MATRIX BOUNDS ---</span>
                              <span className="text-[#D4AF37]">{selectedPage.header.free_space_pointer - 48}B FREE</span>
                            </div>

                            {/* Slotted tuples / cells data chunk (Expands from 4096 bottom up) */}
                            <div className="bg-blue-500/5 p-2 text-blue-450">
                              <div className="font-semibold flex justify-between">
                                <span>[0x{selectedPage.header.free_space_pointer.toString(16).toUpperCase()} - 0xFFF] HEAP TUPLECELL MATRIX</span>
                                <span>{4096 - selectedPage.header.free_space_pointer} bytes</span>
                              </div>
                              <div className="text-[9px] text-zinc-500">
                                Packs serialized row byte payloads (aligned offsets backwards)
                              </div>
                            </div>
                          </div>
                        </div>

                        {/* Slotted raw deserialize tuples cells */}
                        <div className="md:col-span-7 flex flex-col gap-2">
                          <span className="text-[10.5px] font-mono font-bold text-zinc-500 uppercase tracking-widest">
                            Materialized Tuple Cells Heap (Deserialized Row Blocks)
                          </span>
                          <div className="bg-[#0A0A0A] border border-[#222] overflow-y-auto max-h-[160px] p-3 font-mono text-[11px] space-y-2">
                            {selectedPage.rows.map((row, idx) => {
                              const isUncommitted = row.tx_created > 1000 && !db?.tx.getCommittedTransactions().has(row.tx_created);
                              const isDeletedAndCommitted = row.tx_expired !== null && db?.tx.getCommittedTransactions().has(row.tx_expired);

                              return (
                                <div key={idx} className={`p-2.5 border ${
                                  isDeletedAndCommitted ? "bg-red-950/5 opacity-40 text-zinc-600 border-red-950/20" :
                                  isUncommitted ? "bg-amber-950/5 text-amber-300 border-amber-900/40" : "bg-[#0F0F0F] border-[#222] text-zinc-300"
                                }`}>
                                  <div className="flex justify-between items-center text-[10px] text-zinc-500 mb-1.5 border-b border-[#222] pb-1">
                                    <span className="font-bold text-zinc-400">CELL #{idx} [Row ID: "{row.id}"]</span>
                                    <span>created: Tx {row.tx_created} {row.tx_expired !== null && `| expired: Tx ${row.tx_expired}`}</span>
                                  </div>
                                  <pre className="text-[10px] text-zinc-400 overflow-x-auto select-all leading-normal">
                                    {JSON.stringify(row.data, null, 1)}
                                  </pre>
                                  {row.rollback_ptr && (
                                    <div className="text-[8.5px] text-[#D4AF37]/70 mt-1">
                                      ↩ Rollback MVCC Pointer: "{row.rollback_ptr}"
                                    </div>
                                  )}
                                </div>
                              );
                            })}
                            {selectedPage.rows.length === 0 && (
                              <div className="text-zinc-650 text-center py-6 italic font-serif">
                                Page buffer contains zero serialized tuple entries.
                              </div>
                            )}
                          </div>
                        </div>

                      </div>
                    </div>
                  )}
                </motion.div>
              )}

              {/* 2. B-TREE & HASH INDEXES TAB */}
              {activeTab === "index" && (
                <motion.div
                  key="index_tab"
                  initial={{ opacity: 0, y: 10 }}
                  animate={{ opacity: 1, y: 0 }}
                  exit={{ opacity: 0, y: -10 }}
                  className="flex flex-col gap-4 flex-1 justify-start h-full"
                >
                  <div className="flex flex-col gap-1.5">
                    <h3 className="text-xl md:text-2xl font-serif font-bold text-[#D4AF37] tracking-tight">
                      B-Tree / Hash Sparse Indexes
                    </h3>
                    <p className="text-xs text-zinc-400 font-sans italic">
                      Aureum dynamically structures B-Tree ranges. Nodes split in half when key density exceeds 4, building elegant leaf branches.
                    </p>
                  </div>

                  {/* Find B-Tree pages for visualization */}
                  {pagesList.filter(p => p.header.page_type.startsWith("INDEX_")).map((idxPage) => {
                    const isBtree = idxPage.header.page_type === PageType.INDEX_BTREE;

                    return (
                      <div key={idxPage.header.page_id} className="border border-[#222] bg-[#0A0A0A] p-5 space-y-4">
                        <div className="flex justify-between items-center border-b border-[#222] pb-2.5">
                          <div className="flex items-center gap-2">
                            <span className="text-xs font-mono font-bold text-emerald-400 px-2.5 py-0.5 border border-emerald-900 bg-emerald-950/20 uppercase tracking-widest text-[9px]">
                              {idxPage.header.page_type}
                            </span>
                            <span className="text-xs text-zinc-300 font-mono">
                              Page #{idxPage.header.page_id} (Table: "{idxPage.tableName}")
                            </span>
                          </div>
                          <span className="text-[10px] text-zinc-550 font-mono uppercase tracking-widest">slot_count: {idxPage.header.slot_count}</span>
                        </div>

                        {/* Rendering B-Tree Blocks */}
                        {isBtree && idxPage.btree ? (
                          <div className="flex flex-col gap-4 font-mono text-xs">
                            <div className="flex items-center gap-2 text-[10px] text-zinc-500 uppercase tracking-wider">
                              <span>Hierarchy Layout:</span>
                              <span className="text-zinc-400 bg-[#141414] px-2 py-0.5 border border-[#222]">Root / Node Parent: {idxPage.btree.parent !== null ? `Page ${idxPage.btree.parent}` : "Is Root Node"}</span>
                            </div>
                            
                            <div className="flex flex-col md:flex-row items-center justify-center gap-5 py-4 bg-[#0F0F0F] border border-[#222] p-3 overflow-x-auto">
                              
                              {/* Left / Base representation representing keys */}
                              <div className="flex flex-col items-center shrink-0">
                                <div className="text-[9px] text-zinc-500 uppercase tracking-widest mb-2 font-sans font-bold">
                                  {idxPage.btree.isLeaf ? "Leaf Index Node" : "Internal Range Pointer"}
                                </div>
                                <div className="flex items-stretch border border-emerald-600 bg-[#0A0A0A] text-emerald-400 overflow-hidden shadow-md">
                                  {idxPage.btree.keys.map((k, kIdx) => (
                                    <div key={kIdx} className="flex items-center divide-x divide-emerald-800 border-r border-[#222] last:border-r-0">
                                      <span className="px-3 py-2 font-bold bg-[#0A0A0A]">{k}</span>
                                      <span className="px-2 py-2 text-[9px] bg-[#141414] text-zinc-500 font-bold" title="Pointer sheet destination ID">
                                        P{idxPage.btree?.children[kIdx]}
                                      </span>
                                    </div>
                                  ))}
                                  {idxPage.btree.keys.length === 0 && (
                                    <div className="px-6 py-2.5 text-zinc-650 italic text-[11px]">No keys initialized</div>
                                  )}
                                </div>
                                <div className="text-[10px] text-zinc-500 mt-2 font-sans italic">
                                  Node key density: {idxPage.btree.keys.length} / 4 keys max
                                </div>
                              </div>

                              {idxPage.btree.isLeaf && (
                                <div className="hidden md:block select-none text-zinc-600 font-bold">──►</div>
                              )}

                              {idxPage.btree.isLeaf && (
                                <div className="flex flex-col justify-center gap-1.5 bg-[#0A0A0A] p-3 border border-[#222] flex-wrap max-w-sm shrink-0 text-[10px]">
                                  <div className="text-[#D4AF37] font-sans mb-1 font-bold uppercase tracking-widest text-[9px]">Resolved Leaf Mappings:</div>
                                  {idxPage.btree.keys.map((k, idx) => (
                                    <div key={idx} className="flex justify-between gap-6 px-2.5 py-1.5 bg-[#0F0F0F] border border-[#1A1A1A]">
                                      <span className="text-emerald-400 font-bold">Key: {k}</span>
                                      <span className="text-zinc-400 font-mono">Row in Page #{idxPage.btree?.children[idx]}</span>
                                    </div>
                                  ))}
                                </div>
                              )}

                            </div>
                          </div>
                        ) : (
                          // Rendering Hash Index Slots
                          <div className="grid grid-cols-2 sm:grid-cols-4 gap-3 py-1 font-mono text-[11px]">
                            {idxPage.rows.map((row) => (
                              <div key={row.id} className="p-3 bg-[#0F0F0F] border border-[#222] flex flex-col gap-1.5 hover:border-[#D4AF37]/50">
                                <span className="text-emerald-400 font-bold">Hash bucket Key: "{row.data.key}"</span>
                                <span className="text-[10px] text-zinc-500">Slots pointing: Pages [{(row.data.page_ids as number[]).join(", ")}]</span>
                              </div>
                            ))}
                            {idxPage.rows.length === 0 && (
                              <div className="col-span-4 text-zinc-600 italic text-center py-6 font-serif">No hash buckets seeded</div>
                            )}
                          </div>
                        )}
                      </div>
                    );
                  })}
                  {pagesList.filter(p => p.header.page_type.startsWith("INDEX_")).length === 0 && (
                    <div className="text-zinc-600 text-center py-12 italic font-serif">
                      No indexes detected. Run a table or CREATE INDEX clause to allocate indexing nodes.
                    </div>
                  )}
                </motion.div>
              )}

              {/* 3. MVCC ROW VERSIONS TAB */}
              {activeTab === "mvcc" && (
                <motion.div
                  key="mvcc_tab"
                  initial={{ opacity: 0, y: 10 }}
                  animate={{ opacity: 1, y: 0 }}
                  exit={{ opacity: 0, y: -10 }}
                  className="flex flex-col gap-4 flex-1 justify-start h-full"
                >
                  <div className="flex flex-col gap-1.5">
                    <h3 className="text-xl md:text-2xl font-serif font-bold text-[#D4AF37] tracking-tight">
                      Multi-Version Concurrency Records (MVCC)
                    </h3>
                    <p className="text-xs text-zinc-400 font-sans italic">
                      Tuple Versioning Matrix. Updates and deletes write new versions, managing reader snapshots with non-blocking concurrency protocols.
                    </p>
                  </div>

                  {/* Render active tables Row history representation */}
                  {schemasList.map((schema) => {
                    const pages = pagesList.filter((p) => p.tableName === schema.name && p.header.page_type === PageType.DATA);
                    const allVersions = pages.flatMap((p) => p.rows);

                    return (
                      <div key={schema.name} className="border border-[#222] bg-[#0A0A0A] p-5 space-y-3.5">
                        <div className="text-xs font-mono font-bold text-[#D4AF37] uppercase flex justify-between tracking-wider">
                          <span>TABLE: "{schema.name}" VERSION HEAP</span>
                          <span className="text-zinc-500 font-bold uppercase tracking-widest text-[10px]">Total records: {allVersions.length}</span>
                        </div>

                        <div className="overflow-x-auto border border-[#222] bg-[#0F0F0F]">
                          <table className="w-full text-left font-mono text-xs border-collapse">
                            <thead>
                              <tr className="bg-[#141414] border-b border-[#222] text-zinc-400 font-bold uppercase text-[9px] tracking-wider">
                                <th className="px-3 py-2.5">Logical Row ID</th>
                                <th className="px-3 py-2.5">Tx Created</th>
                                <th className="px-3 py-2.5">Tx Expired</th>
                                <th className="px-3 py-2.5">Visible Status</th>
                                <th className="px-3 py-2.5">Mutable Payload Block</th>
                              </tr>
                            </thead>
                            <tbody>
                              {allVersions.map((row, rIdx) => {
                                const isVisibleNoTx = db?.tx.isRowVisible(row, null);
                                const isVisibleActiveTx = db?.activeTxId ? db.tx.isRowVisible(row, db.activeTxId) : isVisibleNoTx;

                                return (
                                  <tr key={rIdx} className="border-b border-zinc-900 hover:bg-zinc-900/30">
                                    <td className="px-3 py-2.5 text-zinc-300 font-bold truncate max-w-[130px]" title={row.id}>{row.id}</td>
                                    <td className="px-3 py-2.5">
                                      <span className="px-2 py-0.5 rounded bg-zinc-900 text-emerald-400 font-bold text-[10px]">
                                        Tx {row.tx_created}
                                      </span>
                                    </td>
                                    <td className="px-3 py-2.5">
                                      {row.tx_expired !== null ? (
                                        <span className="px-2 py-0.5 rounded bg-zinc-900 text-red-400 font-bold text-[10px]">
                                          Tx {row.tx_expired}
                                        </span>
                                      ) : (
                                        <span className="text-zinc-600 font-bold">-</span>
                                      )}
                                    </td>
                                    <td className="px-3 py-2.5">
                                      {isVisibleActiveTx ? (
                                        <span className="text-emerald-500 font-bold text-[11px] flex items-center gap-1">
                                          ● Visible
                                        </span>
                                      ) : (
                                        <span className="text-zinc-600 font-bold text-[11px] flex items-center gap-1">
                                          ○ Expired
                                        </span>
                                      )}
                                    </td>
                                    <td className="px-3 py-2.5 text-zinc-400 truncate max-w-[180px] text-[10px]">
                                      {JSON.stringify(row.data)}
                                    </td>
                                  </tr>
                                );
                              })}
                              {allVersions.length === 0 && (
                                <tr>
                                  <td colSpan={5} className="px-3 py-6 text-center text-zinc-650 italic">
                                    Table contains zero rows. Insert records using the SQL Console.
                                  </td>
                                </tr>
                              )}
                            </tbody>
                          </table>
                        </div>
                      </div>
                    );
                  })}
                </motion.div>
              )}

              {/* 4. WRITE-AHEAD LOG (WAL) TAB */}
              {activeTab === "wal" && (
                <motion.div
                  key="wal_tab"
                  initial={{ opacity: 0, y: 10 }}
                  animate={{ opacity: 1, y: 0 }}
                  exit={{ opacity: 0, y: -10 }}
                  className="flex flex-col gap-4 flex-1 justify-start h-full font-mono text-xs"
                >
                  <div className="flex flex-col gap-1.5 h-full">
                    <h3 className="text-xl md:text-2xl font-serif font-bold text-[#D4AF37] tracking-tight">
                      Write-Ahead Log (WAL) File
                    </h3>
                    <p className="text-xs text-zinc-400 font-sans italic">
                      Aureum logs write operations sequentially to public disk logs before committing changes, guaranteeing transaction durability.
                    </p>
                  </div>

                  {/* WAL Log sequences */}
                  <div className="space-y-2.5 max-h-[340px] overflow-y-auto">
                    {walLogs.map((log) => {
                      let typeTagColor = "border-[#222] text-zinc-400";
                      if (log.type === "COMMIT") typeTagColor = "border-[#D4AF37] text-[#D4AF37] bg-amber-950/15";
                      else if (log.type === "BEGIN") typeTagColor = "border-blue-900 text-blue-400 bg-blue-950/10";
                      else if (log.type === "ABORT" || log.type === "ROLLBACK") typeTagColor = "border-red-950 text-red-500 bg-red-950/10";
                      else if (log.type === "INSERT") typeTagColor = "border-[#222] text-emerald-400 bg-[#0F0F0F]";
                      else if (log.type === "UPDATE") typeTagColor = "border-[#222] text-amber-400 bg-[#0F0F0F]";

                      return (
                        <div key={log.lsn} className="p-3.5 bg-[#0A0A0A] border border-[#222] flex flex-col md:flex-row justify-between gap-3 hover:border-zinc-550 transition-colors">
                          <div className="flex gap-3.5 items-start">
                            <div className="flex flex-col shrink-0">
                              <span className="font-bold text-[#D4AF37] text-[11px]">LSN #{log.lsn}</span>
                              <span className="text-[9px] text-zinc-550 mt-0.5">{log.timestamp}</span>
                            </div>
                            <div className={`px-2 py-0.5 text-[9px] font-bold uppercase select-none shrink-0 border ${typeTagColor}`}>
                              {log.type}
                            </div>
                            <div className="flex flex-col font-mono text-[11px] text-zinc-300">
                              <span className="font-semibold text-zinc-200">Transaction Tx: [ {log.tx_id} ]</span>
                              {log.tableName && (
                                <span className="text-zinc-500 text-[10px] mt-0.5">
                                  Alter: Table "{log.tableName}" | Row key: "{log.rowId}"
                                </span>
                              )}
                            </div>
                          </div>

                          {/* Render Before Image on disk updates if relevant */}
                          {(log.beforeImage || log.afterImage) && (
                            <div className="bg-[#0F0F0F] p-2.5 border border-[#1A1A1A] text-[10px] space-y-1 md:max-w-xs shrink-0 self-start">
                              {log.beforeImage && (
                                <div className="text-zinc-550 truncate font-mono">
                                  Before: {JSON.stringify(log.beforeImage)}
                                </div>
                              )}
                              {log.afterImage && (
                                <div className="text-emerald-500/80 truncate font-semibold font-mono">
                                  After: {JSON.stringify(log.afterImage)}
                                </div>
                              )}
                            </div>
                          )}
                        </div>
                      );
                    })}

                    {walLogs.length === 0 && (
                      <div className="text-zinc-600 py-12 text-center text-xs italic font-serif">
                        WAL streams are currently idle. Execute write queries to generate append listings.
                      </div>
                    )}
                  </div>
                </motion.div>
              )}

              {/* 5. EXPLAIN PLAN TAB */}
              {activeTab === "plan" && (
                <motion.div
                  key="plan_tab"
                  initial={{ opacity: 0, y: 10 }}
                  animate={{ opacity: 1, y: 0 }}
                  exit={{ opacity: 0, y: -10 }}
                  className="flex flex-col gap-4 flex-1 justify-start h-full"
                >
                  <div className="flex flex-col gap-1.5">
                    <h3 className="text-xl md:text-2xl font-serif font-bold text-[#D4AF37] tracking-tight">
                      Execution Plan Optimizer
                    </h3>
                    <p className="text-xs text-zinc-400 font-sans italic">
                      Cost-Based execution plans. This diagram visualizes query scan routes, estimated logical cost constraints, and optimization levels pipelines.
                    </p>
                  </div>

                  {lastQueryResult?.plan ? (
                    <div className="border border-[#222] bg-[#0A0A0A] p-5 space-y-4 font-mono text-xs">
                      <div className="text-[11px] font-bold text-[#D4AF37] border-b border-[#222] pb-2.5 uppercase tracking-widest">
                        ESTIMATED PIPELINE WORKFLOW (RECURSIVE PLAN TREE)
                      </div>
                      
                      {/* Interactive Visual Execution Tree Diagrams */}
                      <div className="flex flex-col gap-3 py-2 select-none">
                        {/* Recursive visual node parser */}
                        {(() => {
                           const renderNode = (node: PlanNode, isPrimary = true) => {
                            let itemTheme = "border-[#222] text-zinc-300";
                            if (node.type === "PROJECT") itemTheme = "border-[#D4AF37]/50 text-amber-200 bg-[#D4AF37]/5";
                            else if (node.type === "LIMIT") itemTheme = "border-blue-900 text-blue-300 bg-blue-950/10";
                            else if (node.type === "INDEX_SCAN") itemTheme = "border-emerald-700 text-emerald-400 bg-emerald-950/15 font-bold border-2";
                            else if (node.type === "FILTER") itemTheme = "border-[#222] text-orange-400 bg-[#0F0F0F]";
                            else if (node.type === "SEQ_SCAN") itemTheme = "border-red-950 text-red-450 bg-[#0F0F0F] border-dashed";

                            return (
                              <div key={node.details} className="flex flex-col items-center">
                                <div className={`px-4 py-3 border rounded-none max-w-md w-full flex flex-col gap-2 ${itemTheme}`}>
                                  <div className="flex justify-between items-center text-[10px] font-bold border-b border-white/5 pb-1.5 font-mono uppercase tracking-wider">
                                    <span>{node.type}</span>
                                    <span>
                                      Cost: <strong className="text-zinc-100">{node.cost}</strong> | Rows: <strong className="text-zinc-100">{node.estimatedRows}</strong>
                                    </span>
                                  </div>
                                  <div className="text-[10px] text-zinc-405 font-mono select-all font-semibold leading-relaxed">{node.details}</div>
                                </div>
                                {node.children && node.children.length > 0 && (
                                  <div className="flex flex-col items-center mt-3 gap-3 w-full">
                                    <div className="text-zinc-600 select-none font-bold text-[9px] uppercase tracking-widest">▲ [Pipes Stream Payload]</div>
                                    <div className="flex gap-4 justify-center w-full flex-wrap">
                                      {node.children.map((child) => renderNode(child, false))}
                                    </div>
                                  </div>
                                )}
                              </div>
                            );
                          };
                          return renderNode(lastQueryResult.plan);
                        })()}
                      </div>
                    </div>
                  ) : (
                    <div className="text-zinc-600 text-center py-12 font-serif text-xs italic">
                      No Execution Plan records parsed. Execute a relational SELECT query to render cost pipelines.
                    </div>
                  )}
                </motion.div>
              )}

            </AnimatePresence>
            
            {/* Explanatory footer info string - Editorial style */}
            <div className="text-[10px] border-t border-[#222] pt-4.5 text-zinc-500 font-mono mt-3 flex items-center gap-2 select-none leading-relaxed">
              <Info className="w-3.5 h-3.5 text-[#D4AF37] shrink-0" />
              <span>
                Simulated fully in TypeScript based on real storage layouts (Slotted-pages, 4096-byte blocks, transactional segment allocators, and ARIES durability guarantees).
              </span>
            </div>
          </section>

        </div>

      </main>

      {/* ARIES ATOMIC CORE RECOVERY DIALOG POPUP */}
      {showRecoveryLogs && (
        <div className="fixed inset-0 bg-[#000000]/90 backdrop-blur-sm z-50 flex items-center justify-center p-4">
          <motion.div
            initial={{ scale: 0.96, opacity: 0 }}
            animate={{ scale: 1, opacity: 1 }}
            className="bg-[#0F0F0F] border border-[#222] max-w-2xl w-full p-6 space-y-4 rounded-none shadow-2xl"
          >
            <div className="border-b border-[#222] pb-3 flex items-center gap-2 text-[#D4AF37] font-mono text-xs font-bold uppercase tracking-widest">
              <RefreshCw className="w-3.5 h-3.5 animate-spin shrink-0 text-[#D4AF37]" />
              AUREUM ARIES RECOVERY PIPELINE LOGS
            </div>

            <div className="space-y-1.5 font-sans">
              <h4 className="text-xs uppercase font-bold tracking-wider text-zinc-400">ARIES WAL INTEGRITY REPLAY COMPLETION:</h4>
              <div className="grid grid-cols-2 gap-4 pt-1 font-mono text-xs">
                <div className="bg-[#0A0A0A] p-3 border border-[#222]">
                  <span className="text-zinc-550 block text-[9px] uppercase tracking-wider font-bold mb-1">Replayed operations (REDO):</span>
                  <span className="text-emerald-400 font-bold text-sm">+{recoveredCount.replayed} records reseeded</span>
                </div>
                <div className="bg-[#0A0A0A] p-3 border border-[#222]">
                  <span className="text-zinc-550 block text-[9px] uppercase tracking-wider font-bold mb-1">Rolled back tx (UNDO):</span>
                  <span className="text-amber-500 font-bold text-sm">-{recoveredCount.undone} actions expunged</span>
                </div>
              </div>
            </div>

            {/* Live scrolling command block recovery log */}
            <div className="bg-[#0A0A0A] p-3.5 font-mono text-[10px] text-zinc-400 space-y-1 overflow-y-auto h-[190px] border border-[#222] tracking-wide select-all">
              {recoveryLogList.map((line, idx) => (
                <div key={idx} className={
                  line.startsWith("REDO") ? "text-emerald-400" :
                  line.startsWith("UNDO") ? "text-amber-500" :
                  line.startsWith("=================") ? "text-zinc-500 font-bold text-center py-1 border-b border-[#222] pb-1 uppercase tracking-widest" : "text-zinc-350"
                }>
                  {line}
                </div>
              ))}
            </div>

            <div className="flex justify-end pt-3 border-t border-[#222]">
              <button
                onClick={() => setShowRecoveryLogs(false)}
                className="px-5 py-2.5 font-mono text-[11px] font-bold bg-[#D4AF37] text-black hover:bg-amber-405 active:scale-[0.98] cursor-pointer transition-all uppercase tracking-wider rounded-none"
              >
                PROCEED TO DATABASE KERNEL
              </button>
            </div>
          </motion.div>
        </div>
      )}

    </div>
  );
}
