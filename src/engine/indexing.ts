/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import { Page, PageType } from "../types";
import { StorageEngine } from "./storage";

export class IndexingEngine {
  private storage: StorageEngine;

  constructor(storage: StorageEngine) {
    this.storage = storage;
  }

  /**
   * Search a B-Tree index page for a given key.
   * Returns the destination page ID containing the records (typically DATA page).
   */
  public searchBTree(indexPageId: number, key: number | string): { leafPageId: number; dataPageId: number; steps: string[] } {
    const steps: string[] = [];
    let currentPageId = indexPageId;
    const keyStr = String(key);

    this.storage.log("INDEX", "INFO", `[B-TREE Search] Locating key "${key}" starting from root Page [${indexPageId}]`);

    while (true) {
      const page = this.storage.getPage(currentPageId);
      if (page.header.page_type !== PageType.INDEX_BTREE || !page.btree) {
        steps.push(`Page [${currentPageId}] is not a B-Tree page!`);
        break;
      }

      const btree = page.btree;
      steps.push(`Reading B-Tree Node Page [${currentPageId}] (${btree.isLeaf ? "Leaf" : "Internal"}). Keys: [${btree.keys.join(", ")}]`);

      // Find the first index where search_key < key
      let slotIdx = 0;
      while (slotIdx < btree.keys.length && Number(key) >= Number(btree.keys[slotIdx])) {
        // If exact match on leaf node, we return it
        if (btree.isLeaf && btree.keys[slotIdx] === keyStr) {
          const targetPageId = btree.children[slotIdx];
          steps.push(`Match found inside Leaf Node. Points to DATA Page [${targetPageId}]`);
          return { leafPageId: currentPageId, dataPageId: targetPageId, steps };
        }
        slotIdx++;
      }

      if (btree.isLeaf) {
        // key not found in leaf, but we point to the closest match or default page
        const fallbackPage = btree.children[Math.max(0, slotIdx - 1)] || btree.children[0];
        steps.push(`Key "${key}" not in Leaf. Fallback pointer to DATA Page [${fallbackPage}]`);
        return { leafPageId: currentPageId, dataPageId: fallbackPage, steps };
      } else {
        // Traverse to child index node
        const childPageId = btree.children[Math.min(slotIdx, btree.children.length - 1)];
        steps.push(`Key is between keys. Traversing down B-Tree to Child Page [${childPageId}]`);
        currentPageId = childPageId;
      }
    }

    return { leafPageId: indexPageId, dataPageId: -1, steps };
  }

  /**
   * Inserts a key-value pointer into the B-Tree index.
   * Demonstrates splitting when node key size exceeds 4.
   */
  public insertIntoBTree(indexPageId: number, key: number | string, dataPageId: number) {
    const keyStr = String(key);
    this.storage.log("INDEX", "INFO", `[B-TREE Insert] Indexing key "${key}" pointing to DATA Page [${dataPageId}]`);

    const { leafPageId } = this.searchBTree(indexPageId, key);
    const leaf = this.storage.getPage(leafPageId);

    if (!leaf.btree) return;

    // Inside-node unique sorted insertion
    let insertPos = 0;
    while (insertPos < leaf.btree.keys.length && Number(key) > Number(leaf.btree.keys[insertPos])) {
      insertPos++;
    }

    // Insert key and children
    leaf.btree.keys.splice(insertPos, 0, keyStr);
    leaf.btree.children.splice(insertPos, 0, dataPageId);
    leaf.header.slot_count = leaf.btree.keys.length;

    this.storage.writePage(leafPageId, leaf);
    this.storage.log("INDEX", "SUCCESS", `Inserted key "${key}" into B-Tree leaf Page [${leafPageId}] at slot ${insertPos}. Node Keys: [${leaf.btree.keys.join(", ")}]`);

    // Splitting condition: If keys count exceeds 4 (demonstrative purpose)
    if (leaf.btree.keys.length > 4) {
      this.splitBTreeNode(leafPageId);
    }
  }

  /**
   * Split a crowded B-Tree node into two, and propagate parent pointer upwards.
   */
  private splitBTreeNode(pageId: number) {
    const page = this.storage.getPage(pageId);
    if (!page.btree) return;

    this.storage.log("INDEX", "WARNING", `[B-TREE Split] Page [${pageId}] limit exceeded (${page.btree.keys.length} keys). Splitting node...`);

    const keys = page.btree.keys;
    const children = page.btree.children;
    const isLeaf = page.btree.isLeaf;

    const midIndex = Math.floor(keys.length / 2);
    const promoteKey = keys[midIndex];

    // Create Right sibling
    const rightPage = this.storage.allocateNewPage(PageType.INDEX_BTREE, page.tableName);
    rightPage.btree = {
      isLeaf: isLeaf,
      keys: keys.slice(midIndex + (isLeaf ? 0 : 1)), // Leaf keeps midKey, internal promotes it without duplicate
      children: children.slice(midIndex + (isLeaf ? 0 : 1)),
      parent: page.btree.parent,
    };
    rightPage.header.slot_count = rightPage.btree.keys.length;
    
    // Update Left current node
    page.btree.keys = keys.slice(0, midIndex);
    page.btree.children = children.slice(0, midIndex + (isLeaf ? 0 : 1));
    page.header.slot_count = page.btree.keys.length;

    this.storage.writePage(pageId, page);
    this.storage.writePage(rightPage.header.page_id, rightPage);

    this.storage.log("INDEX", "SUCCESS", `Split Page [${pageId}] into Left [${pageId}] ([${page.btree.keys.join(", ")}]) and Right [${rightPage.header.page_id}] ([${rightPage.btree.keys.join(", ")}]). Promoting key "${promoteKey}".`);

    // Propagate up to Parent
    const parentId = page.btree.parent;
    if (parentId === null) {
      // Create new Root Node!
      const newRoot = this.storage.allocateNewPage(PageType.INDEX_BTREE, page.tableName);
      newRoot.btree = {
        isLeaf: false,
        keys: [promoteKey],
        children: [pageId, rightPage.header.page_id],
        parent: null,
      };
      newRoot.header.slot_count = 1;

      // Update children parent references
      page.btree.parent = newRoot.header.page_id;
      rightPage.btree.parent = newRoot.header.page_id;

      this.storage.writePage(pageId, page);
      this.storage.writePage(rightPage.header.page_id, rightPage);
      this.storage.writePage(newRoot.header.page_id, newRoot);

      this.storage.log("INDEX", "SUCCESS", `B-Tree dynamically grew! Created new Root Node Page [${newRoot.header.page_id}] managing children [${pageId}, ${rightPage.header.page_id}].`);
    } else {
      // Insert promoteKey into parent
      const parentPage = this.storage.getPage(parentId);
      if (parentPage.btree) {
        let parentPos = 0;
        while (parentPos < parentPage.btree.keys.length && Number(promoteKey) > Number(parentPage.btree.keys[parentPos])) {
          parentPos++;
        }
        parentPage.btree.keys.splice(parentPos, 0, promoteKey);
        parentPage.btree.children.splice(parentPos + 1, 0, rightPage.header.page_id);
        parentPage.header.slot_count = parentPage.btree.keys.length;

        // update parent reference for the newly created right sibling
        rightPage.btree.parent = parentId;

        this.storage.writePage(parentId, parentPage);
        this.storage.writePage(rightPage.header.page_id, rightPage);

        this.storage.log("INDEX", "SUCCESS", `Promoted key "${promoteKey}" into existing Parent Node Page [${parentId}].`);

        if (parentPage.btree.keys.length > 4) {
          // Recursive split
          this.splitBTreeNode(parentId);
        }
      }
    }
  }

  /**
   * Search HASH index page for rapid lookup in matching table categories.
   */
  public searchHash(hashPageId: number, value: string): { pageIds: number[]; steps: string[] } {
    const steps: string[] = [];
    const hashPage = this.storage.getPage(hashPageId);
    
    steps.push(`Performing HASH lookup on Index Page [${hashPageId}] for attribute "${value}"`);
    
    const bucket = hashPage.rows.find((row) => String(row.data.key).toLowerCase() === value.toLowerCase());
    
    if (bucket && bucket.data.page_ids) {
      const pageIds = bucket.data.page_ids as number[];
      steps.push(`Hash slot match! Value "${value}" hashes directly to cluster: DATA Pages [${pageIds.join(", ")}]`);
      return { pageIds, steps };
    }

    steps.push(`No Hash bucket match found for value "${value}". Fallback to full linear sequential table scan.`);
    return { pageIds: [], steps };
  }

  /**
   * Inserts key values into standard Hash Indexes
   */
  public insertIntoHash(hashPageId: number, key: string, dataPageId: number) {
    const hashPage = this.storage.getPage(hashPageId);
    this.storage.log("INDEX", "INFO", `[HASH Insert] Mapping value "${key}" pointing to DATA Page [${dataPageId}]`);

    const lowerKey = key.toLowerCase();
    const existingBucket = hashPage.rows.find((row) => String(row.data.key).toLowerCase() === lowerKey);

    if (existingBucket) {
      const pageIds = existingBucket.data.page_ids as number[];
      if (!pageIds.includes(dataPageId)) {
        pageIds.push(dataPageId);
        this.storage.writePage(hashPageId, hashPage);
        this.storage.log("INDEX", "SUCCESS", `Added Page [${dataPageId}] to existing HASH index bucketing for key "${key}".`);
      }
    } else {
      // Create new hash slot bucket
      hashPage.rows.push({
        id: `hash_bucket_${Date.now()}_${Math.random().toString(36).substr(2, 4)}`,
        tx_created: 0,
        tx_expired: null,
        rollback_ptr: null,
        data: {
          key: key,
          page_ids: [dataPageId]
        }
      });
      hashPage.header.slot_count = hashPage.rows.length;
      this.storage.writePage(hashPageId, hashPage);
      this.storage.log("INDEX", "SUCCESS", `Created new HASH index bucket for key "${key}" pointing to DATA Page [${dataPageId}].`);
    }
  }
}
