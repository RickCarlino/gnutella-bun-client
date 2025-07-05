import { Hash } from "./Hash";
import { SharedFile } from "./types";

export class SimpleFileManager {
  private sharedFiles: Map<number, SharedFile>;
  private fileCounter: number;

  constructor() {
    this.sharedFiles = new Map();
    this.fileCounter = 1;
  }

  addFile(filename: string, size: number, keywords: string[]): number {
    const index = this.fileCounter++;
    const sha1 = Hash.sha1(filename);
    this.sharedFiles.set(index, { filename, size, index, keywords, sha1 });
    return index;
  }

  removeFile(index: number): boolean {
    return this.sharedFiles.delete(index);
  }

  getFiles(): SharedFile[] {
    return Array.from(this.sharedFiles.values());
  }

  getFile(index: number): SharedFile | undefined {
    return this.sharedFiles.get(index);
  }

  matchesQuery(searchCriteria: string): boolean {
    const queryKeywords = this.extractKeywords(searchCriteria);
    return this.getFiles().some((file) =>
      queryKeywords.some((queryKeyword) =>
        file.keywords.some((fileKeyword) =>
          fileKeyword.toLowerCase().includes(queryKeyword),
        ),
      ),
    );
  }

  getMatchingFiles(searchCriteria: string): SharedFile[] {
    const queryKeywords = this.extractKeywords(searchCriteria);
    return this.getFiles().filter((file) =>
      queryKeywords.every((queryKeyword) =>
        file.keywords.some((fileKeyword) =>
          fileKeyword.toLowerCase().includes(queryKeyword),
        ),
      ),
    );
  }

  private extractKeywords(searchCriteria: string): string[] {
    return searchCriteria
      .toLowerCase()
      .split(/\s+/)
      .filter((k) => k.length > 0);
  }
}
