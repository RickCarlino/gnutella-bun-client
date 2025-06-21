import { SharedFile } from "./interfaces";

export class SharedFileManager {
  private files: SharedFile[] = [];
  private fileIndex = 1;

  addFile(filename: string, size: number): SharedFile {
    const keywords = this.extractKeywords(filename);
    const file: SharedFile = {
      index: this.fileIndex++,
      filename,
      size,
      keywords,
    };
    this.files.push(file);
    return file;
  }

  private extractKeywords(filename: string): string[] {
    // Remove extension
    const base = filename.replace(/\.[^.]+$/, "");
    const words: string[] = [];
    
    // Split on non-alphanumeric chars
    const parts = base
      .toLowerCase()
      .split(/[^a-z0-9]+/)
      .filter((w) => w.length >= 3); // Min 3 chars for QRP
    
    words.push(...parts);
    
    // Also add the full filename without extension as a keyword
    words.push(base.toLowerCase());
    
    // For long alphanumeric strings, also add substrings
    if (base.length > 10 && parts.length === 1) {
      // Add some substrings for better matching
      for (let i = 0; i <= base.length - 5; i += 3) {
        const substr = base.toLowerCase().substring(i, i + 8);
        if (substr.length >= 3) {
          words.push(substr);
        }
      }
    }
    
    const uniqueWords = [...new Set(words)]; // Remove duplicates
    console.log(`[KEYWORDS] Extracted from "${filename}": ${uniqueWords.join(", ")}`);
    return uniqueWords;
  }

  searchFiles(criteria: string): SharedFile[] {
    const searchWords = criteria
      .toLowerCase()
      .split(/\s+/)
      .filter((w) => w.length > 0);

    console.log(`[SEARCH] Searching for: "${criteria}"`);
    console.log(`[SEARCH] Search words: ${searchWords.join(", ")}`);
    console.log(`[SEARCH] Available files: ${this.files.length}`);
    
    if (searchWords.length === 0) return [];

    const results = this.files.filter((file) => {
      console.log(`[SEARCH] Checking file: ${file.filename}, keywords: ${file.keywords.join(", ")}`);
      // Check if any search word matches any keyword
      const matches = searchWords.some((searchWord) =>
        file.keywords.some((keyword) => {
          const match = keyword.includes(searchWord);
          if (match) {
            console.log(`[SEARCH] Match found: "${searchWord}" in "${keyword}"`);
          }
          return match;
        })
      );
      return matches;
    });
    
    console.log(`[SEARCH] Found ${results.length} matches`);
    return results;
  }

  getFiles(): SharedFile[] {
    return this.files;
  }

  getKeywords(): string[] {
    const allKeywords = new Set<string>();
    this.files.forEach((file) => {
      file.keywords.forEach((kw) => allKeywords.add(kw));
    });
    return Array.from(allKeywords);
  }
}