/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import { PlanNode, DataType, TableSchema } from "../types";

export class SQLParser {
  /**
   * Simple lexer and parser that parses SQL-inspired queries into structured AST-like action maps.
   */
  public parse(sql: string): any {
    const cleanSql = sql.trim().replace(/;$/, "");
    const tokens = cleanSql.split(/\s+/);
    const cmd = tokens[0].toUpperCase();

    if (cmd === "BEGIN") {
      return { type: "BEGIN", isolation: tokens[1] === "TRANSACTION" ? "READ_COMMITTED" : (tokens[2] || "READ_COMMITTED").toUpperCase() };
    }
    if (cmd === "COMMIT") {
      return { type: "COMMIT" };
    }
    if (cmd === "ROLLBACK") {
      return { type: "ROLLBACK" };
    }

    if (cmd === "CREATE" && tokens[1]?.toUpperCase() === "TABLE") {
      return this.parseCreateTable(cleanSql);
    }

    if (cmd === "DROP" && tokens[1]?.toUpperCase() === "TABLE") {
      return { type: "DROP_TABLE", tableName: tokens[2].toLowerCase() };
    }

    if (cmd === "CREATE" && tokens[1]?.toUpperCase() === "INDEX") {
      return this.parseCreateIndex(cleanSql);
    }

    if (cmd === "INSERT" && tokens[1]?.toUpperCase() === "INTO") {
      return this.parseInsert(cleanSql);
    }

    if (cmd === "SELECT") {
      return this.parseSelect(cleanSql);
    }

    if (cmd === "UPDATE") {
      return this.parseUpdate(cleanSql);
    }

    if (cmd === "DELETE" && tokens[1]?.toUpperCase() === "FROM") {
      return this.parseDelete(cleanSql);
    }

    throw new Error(`Syntax Error: Unsupported SQL-inspired statement "${cmd}"`);
  }

  private parseCreateTable(sql: string): any {
    // CREATE TABLE users (id INTEGER, name STRING)
    const match = sql.match(/CREATE\s+TABLE\s+(\w+)\s*\((.*)\)/i);
    if (!match) {
      throw new Error("Syntax Error in CREATE TABLE definition. Example: CREATE TABLE users (id INTEGER, name STRING)");
    }
    const tableName = match[1].toLowerCase();
    const columnsStr = match[2];
    const columns: any[] = [];
    let pKey = "id";

    columnsStr.split(",").forEach((colDef) => {
      const parts = colDef.trim().split(/\s+/);
      const colName = parts[0];
      let colTypeStr = parts[1].toUpperCase();
      const isPk = colDef.toUpperCase().includes("PRIMARY KEY");

      if (isPk) {
        colTypeStr = colTypeStr.replace(/PRIMARY\s+KEY/i, "").trim();
        pKey = colName;
      }

      let type: DataType = DataType.STRING;
      if (colTypeStr.startsWith("INT")) type = DataType.INTEGER;
      else if (colTypeStr.startsWith("FLOAT")) type = DataType.FLOAT;
      else if (colTypeStr.startsWith("BOOL")) type = DataType.BOOLEAN;
      else if (colTypeStr.startsWith("DATE")) type = DataType.DATETIME;
      else if (colTypeStr.startsWith("JSON")) type = DataType.JSON;
      else if (colTypeStr.startsWith("BLOB") || colTypeStr.startsWith("BIN")) type = DataType.BINARY_BLOB;

      columns.push({
        name: colName,
        type,
        isPrimaryKey: isPk,
      });
    });

    return { type: "CREATE_TABLE", tableName, columns, primaryKey: pKey };
  }

  private parseCreateIndex(sql: string): any {
    // CREATE INDEX idx_cust_country ON customers (country) USING HASH
    const match = sql.match(/CREATE\s+INDEX\s+(\w+)\s+ON\s+(\w+)\s*\((.*)\)(?:\s+USING\s+(\w+))?/i);
    if (!match) {
      throw new Error("Syntax Error in CREATE INDEX. Example: CREATE INDEX idx_name ON customers (country) USING HASH");
    }
    const indexName = match[1].toLowerCase();
    const tableName = match[2].toLowerCase();
    const columns = match[3].split(",").map(c => c.trim().toLowerCase());
    const method = (match[4] || "B-TREE").toUpperCase() as "B-TREE" | "HASH";

    return { type: "CREATE_INDEX", indexName, tableName, columns, indexType: method };
  }

  private parseInsert(sql: string): any {
    // INSERT INTO customers (id, name, country, active, balance) VALUES (106, 'Bob Ross', 'USA', true, 1800.00)
    const match = sql.match(/INSERT\s+INTO\s+(\w+)\s*\((.*)\)\s*VALUES\s*\((.*)\)/i);
    if (!match) {
      throw new Error("Syntax Error in INSERT INTO. Example: INSERT INTO tab (col1) VALUES (val1)");
    }
    const tableName = match[1].toLowerCase();
    const columns = match[2].split(",").map(s => s.trim());
    const valuesPart = match[3];

    // Splitting values, respecting strings in single quotes
    const values: any[] = [];
    let currentToken = "";
    let insideQuote = false;
    for (let i = 0; i < valuesPart.length; i++) {
      const char = valuesPart[i];
      if (char === "'") {
        insideQuote = !insideQuote;
      } else if (char === "," && !insideQuote) {
        values.push(this.coerceValue(currentToken.trim()));
        currentToken = "";
      } else {
        currentToken += char;
      }
    }
    values.push(this.coerceValue(currentToken.trim()));

    if (columns.length !== values.length) {
      throw new Error(`Insert failed: Column count (${columns.length}) does not match Value count (${values.length})`);
    }

    const rowData: Record<string, any> = {};
    columns.forEach((col, idx) => {
      rowData[col] = values[idx];
    });

    return { type: "INSERT", tableName, rowData };
  }

  private parseSelect(sql: string): any {
    // SELECT * FROM customers JOIN orders ON customers.id = orders.customer_id WHERE country = 'USA' LIMIT 5
    const selectRx = /SELECT\s+(.*)\s+FROM\s+(\w+)(?:\s+JOIN\s+(\w+)\s+ON\s+(\w+\.\w+)\s*=\s*(\w+\.\w+))?(?:\s+WHERE\s+(.*?))?(?:\s+ORDER\s+BY\s+(\w+)(?:\s+(ASC|DESC))?)?(?:\s+LIMIT\s+(\d+))?$/i;
    const match = sql.match(selectRx);
    if (!match) {
      throw new Error("Syntax Error in SELECT syntax. Example: SELECT * FROM customers WHERE country = 'USA' LIMIT 5");
    }

    const projection = match[1].trim();
    const primaryTable = match[2].toLowerCase();
    const joinTable = match[3] ? match[3].toLowerCase() : null;
    const joinOnLeft = match[4] ? match[4].toLowerCase() : null;
    const joinOnRight = match[5] ? match[5].toLowerCase() : null;
    const whereStr = match[6] ? match[6].trim() : null;
    const orderByCol = match[7] ? match[7].toLowerCase() : null;
    const orderByDir = (match[8] || "ASC").toUpperCase() as "ASC" | "DESC";
    const limitCount = match[9] ? parseInt(match[9]) : null;

    let filter: { column: string; operator: string; value: any } | null = null;
    if (whereStr) {
      const filterMatch = whereStr.match(/(\w+)\s*(=|>|<|!=)\s*(.*)/);
      if (filterMatch) {
        filter = {
          column: filterMatch[1].trim().toLowerCase(),
          operator: filterMatch[2].trim(),
          value: this.coerceValue(filterMatch[3].trim()),
        };
      }
    }

    return {
      type: "SELECT",
      projection,
      tableName: primaryTable,
      join: joinTable ? {
        table: joinTable,
        onLeft: joinOnLeft,
        onRight: joinOnRight,
      } : null,
      filter,
      orderBy: orderByCol ? { column: orderByCol, dir: orderByDir } : null,
      limit: limitCount,
    };
  }

  private parseUpdate(sql: string): any {
    // UPDATE customers SET balance = 500 WHERE id = 101
    const match = sql.match(/UPDATE\s+(\w+)\s+SET\s+(\w+)\s*=\s*(.*?)(?:\s+WHERE\s+(.*))?$/i);
    if (!match) {
      throw new Error("Syntax Error in UPDATE. Example: UPDATE customers SET balance = 1500 WHERE id = 101");
    }
    const tableName = match[1].toLowerCase();
    const setColumn = match[2].trim().toLowerCase();
    const setValue = this.coerceValue(match[3].trim());
    const whereStr = match[4] ? match[4].trim() : null;

    let filter: { column: string; operator: string; value: any } | null = null;
    if (whereStr) {
      const filterMatch = whereStr.match(/(\w+)\s*(=|>|<|!=)\s*(.*)/);
      if (filterMatch) {
         filter = {
           column: filterMatch[1].trim().toLowerCase(),
           operator: filterMatch[2].trim(),
           value: this.coerceValue(filterMatch[3].trim()),
         };
      }
    }

    return {
      type: "UPDATE_MUTATION",
      tableName,
      setColumn,
      setValue,
      filter,
    };
  }

  private parseDelete(sql: string): any {
    // DELETE FROM customers WHERE country = 'USA'
    const match = sql.match(/DELETE\s+FROM\s+(\w+)(?:\s+WHERE\s+(.*))?$/i);
    if (!match) {
      throw new Error("Syntax Error in DELETE syntax. Example: DELETE FROM customers WHERE country = 'USA'");
    }
    const tableName = match[1].toLowerCase();
    const whereStr = match[2] ? match[2].trim() : null;

    let filter: { column: string; operator: string; value: any } | null = null;
    if (whereStr) {
      const filterMatch = whereStr.match(/(\w+)\s*(=|>|<|!=)\s*(.*)/);
      if (filterMatch) {
        filter = {
          column: filterMatch[1].trim().toLowerCase(),
          operator: filterMatch[2].trim(),
          value: this.coerceValue(filterMatch[3].trim()),
        };
      }
    }

    return {
      type: "DELETE_MUTATION",
      tableName,
      filter,
    };
  }

  private coerceValue(val: string): any {
    if (val.startsWith("'") && val.endsWith("'")) {
      return val.slice(1, -1);
    }
    if (val.toLowerCase() === "true") return true;
    if (val.toLowerCase() === "false") return false;
    if (val === "null") return null;
    const num = Number(val);
    if (!isNaN(num)) return num;
    return val;
  }

  /**
   * Generates a structural node-based execution plan tree containing estimated costs and predicate optimizations.
   */
  public generatePlan(parsedAst: any, schemaMap: Map<string, TableSchema>, indicesMap: Map<string, any[]>): PlanNode {
    if (parsedAst.type !== "SELECT") {
      // Non-select mutations are simple sequential project updates
      return {
        type: "PROJECT",
        cost: 10,
        estimatedRows: 1,
        details: `Mutation action executing on table "${parsedAst.tableName}"`,
        children: [],
      };
    }

    const tableName = parsedAst.tableName;
    const schema = schemaMap.get(tableName);
    const tblRowsCount = schema ? 15 : 5; // Simulating cardinality

    // Check if index matches the filter to apply Predicate Pushdown and Index Selection Optimization!
    let matchingIndex: any = null;
    const tIndices = indicesMap.get(tableName) || [];
    
    if (parsedAst.filter && tIndices.length > 0) {
      const filterCol = parsedAst.filter.column;
      matchingIndex = tIndices.find(idx => idx.columns.includes(filterCol));
    }

    // Leaf Scan Node
    let scanNode: PlanNode;
    if (matchingIndex) {
      const indexType = matchingIndex.type;
      scanNode = {
        type: "INDEX_SCAN",
        cost: Math.round(1.5 + (tblRowsCount * 0.1)),
        estimatedRows: Math.round(tblRowsCount * 0.2), // Indexes reduce standard scanning density
        details: `Index Scan using ${indexType} Index "${matchingIndex.name}" on filter range [${parsedAst.filter.column} ${parsedAst.filter.operator} ${parsedAst.filter.value}] (PREDICATE PUSHDOWN ACTIVE)`,
        children: [],
      };
    } else {
      scanNode = {
        type: "SEQ_SCAN",
        cost: tblRowsCount * 5, // Higher cost for Sequential Table scans
        estimatedRows: tblRowsCount,
        details: `Seq Scan (Full Table Scan) on disk table "${tableName}"`,
        children: [],
      };
    }

    let rootNode = scanNode;

    // Apply Filter node if no matching index pulled (otherwise pushed down directly)
    if (parsedAst.filter && !matchingIndex) {
      const filterNode: PlanNode = {
        type: "FILTER",
        cost: Math.round(tblRowsCount * 1.5),
        estimatedRows: Math.round(tblRowsCount * 0.3),
        details: `Filter rows on condition [${parsedAst.filter.column} ${parsedAst.filter.operator} ${parsedAst.filter.value}]`,
        children: [rootNode],
      };
      rootNode = filterNode;
    }

    // Join Node (Hash Join or Loop Index Join representation)
    if (parsedAst.join) {
      const joinTblName = parsedAst.join.table;
      const joinNode: PlanNode = {
        type: "JOIN",
        cost: rootNode.cost + 20,
        estimatedRows: rootNode.estimatedRows * 1.5,
        details: `Hash Join tables [${tableName}] and [${joinTblName}] ON ${parsedAst.join.onLeft} = ${parsedAst.join.onRight}`,
        children: [
          rootNode,
          {
            type: "SEQ_SCAN",
            cost: 25,
            estimatedRows: 5,
            details: `Sequential Inner Scan on dependent table "${joinTblName}"`,
            children: [],
          }
        ],
      };
      rootNode = joinNode;
    }

    // Order By
    if (parsedAst.orderBy) {
      const sortNode: PlanNode = {
        type: "ORDER_BY",
        cost: rootNode.cost + Math.round(rootNode.estimatedRows * 1.2),
        estimatedRows: rootNode.estimatedRows,
        details: `Sort resultSet on key "${parsedAst.orderBy.column}" (${parsedAst.orderBy.dir})`,
        children: [rootNode],
      };
      rootNode = sortNode;
    }

    // Projection Projection
    const projectNode: PlanNode = {
      type: "PROJECT",
      cost: rootNode.cost + 2,
      estimatedRows: parsedAst.limit ? Math.min(parsedAst.limit, rootNode.estimatedRows) : rootNode.estimatedRows,
      details: `Project final column set: [${parsedAst.projection}]`,
      children: [rootNode],
    };
    rootNode = projectNode;

    // Limit clause
    if (parsedAst.limit !== null) {
      const limitNode: PlanNode = {
        type: "LIMIT",
        cost: rootNode.cost + 1,
        estimatedRows: parsedAst.limit,
        details: `Limit scan size of rows payload to: ${parsedAst.limit}`,
        children: [rootNode],
      };
      rootNode = limitNode;
    }

    return rootNode;
  }
}
