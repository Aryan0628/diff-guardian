/**
 * src/parsers/ast-mapper.ts
 *
 * THE ORCHESTRATOR.
 * Receives FileDiff[] from git-diff.ts.
 * Dispatches each file to the correct language translator.
 * Injects filePath into every FunctionSignature (parser doesn't know filenames).
 * Returns ParseResult[] to the classifier.
 *
 * Responsibilities:
 *  1. WASM grammar lifecycle — lazy load, deduplicate, cache
 *  2. Sequential parsing — tree-sitter is fast, sequential keeps WASM heap flat
 *  3. Memory safety — tree.delete() in finally block, always
 *  4. Error isolation — one bad file never aborts the entire diff run
 *  5. filePath injection — the one place that knows both filename and signature
 */

import { Parser, Language as WasmLanguage, Tree } from 'web-tree-sitter';
import * as path from 'path';

import {
  FileDiff,
  ParseResult,
  AnySignature,
  FunctionSignature,
  Language,
} from '../core/types';

import { EXTENSION_TO_LANGUAGE } from '../core/constants';

// Translators — one per language
import { extractTSSignatures }   from './translators/typescript';
import { extractPySignatures }   from './translators/python';
import { extractGoSignatures }   from './translators/go';
import { extractJavaSignatures } from './translators/java';
import { extractRustSignatures } from './translators/rust';

// ─────────────────────────────────────────────────────────────────────────────
// Types
// ─────────────────────────────────────────────────────────────────────────────

/** Raw output from a translator — before filePath is injected */
type RawSignatureMap = Map<string, AnySignature>;

// ─────────────────────────────────────────────────────────────────────────────
// ASTMapper
// ─────────────────────────────────────────────────────────────────────────────

export class ASTMapper {

  private parser: Parser | null = null;

  /** Fully loaded grammars — keyed by grammar code e.g. 'typescript' */
  private languages: Map<string, WasmLanguage> = new Map();

  /**
   * In-flight load promises — prevents thundering herd.
   * If 10 .ts files arrive simultaneously, only one WASM load fires.
   * Cleaned up after load settles (success or failure).
   */
  private loadingLanguages: Map<string, Promise<WasmLanguage>> = new Map();

  // ── 1. Initialise ──────────────────────────────────────────────────────────

  /**
   * MUST be called before buildSignatureCache().
   * Initialises the web-tree-sitter WASM runtime.
   * Idempotent — safe to call multiple times.
   */
  async init(): Promise<void> {
    if (this.parser) return; // already initialised
    await Parser.init();
    this.parser = new Parser();
  }

  // ── 2. Main entry point ────────────────────────────────────────────────────

  /**
   * Converts FileDiff[] → ParseResult[].
   * One ParseResult per file, containing old and new signature maps.
   *
   * Sequential processing rationale:
   * tree-sitter parses at ~100k lines/sec. Concurrent parsing adds no
   * meaningful throughput benefit and causes non-deterministic WASM heap
   * fragmentation. Sequential keeps memory usage perfectly flat and
   * makes errors easier to reason about.
   */
  async buildSignatureCache(diffs: FileDiff[]): Promise<ParseResult[]> {
    if (!this.parser) {
      throw new Error(
        '[ASTMapper] Not initialised. Call await mapper.init() before buildSignatureCache().'
      );
    }

    const results: ParseResult[] = [];

    for (const diff of diffs) {
      results.push(await this.processDiff(diff));
    }

    return results;
  }

  // ── 3. Per-file processing ─────────────────────────────────────────────────

  private async processDiff(diff: FileDiff): Promise<ParseResult> {
    const language = EXTENSION_TO_LANGUAGE[`.${diff.language}`] as Language | undefined;

    if (!language) {
      return this.skipped(diff.path, `unsupported extension: .${diff.language}`);
    }

    let lang: WasmLanguage;
    try {
      lang = await this.getLanguage(language);
    } catch (err: any) {
      return this.skipped(diff.path, err.message);
    }

    // Swap grammar — one shared parser instance, language changes per file
    this.parser!.setLanguage(lang);

    try {
      const oldSigs = this.extractFromSource(
        diff.oldSource, diff.language, lang, diff.path
      );
      const newSigs = this.extractFromSource(
        diff.newSource, diff.language, lang, diff.path
      );

      return {
        file:     diff.path,
        language,
        oldSigs,
        newSigs,
        skipped:  false,
      };
    } catch (err: any) {
      console.warn(`[ASTMapper] Failed to process "${diff.path}": ${err.message}`);
      return this.skipped(diff.path, err.message, language);
    }
  }

  // ── 4. Source → signature map ──────────────────────────────────────────────

  /**
   * Parses one source string and returns a Map<name, AnySignature>.
   * Injects filePath into every FunctionSignature produced.
   *
   * Memory contract:
   * tree.delete() is called in the finally block unconditionally.
   * Even if the translator throws, WASM memory is freed.
   */
  private extractFromSource(
    source:   string,
    ext:      string,
    lang:     WasmLanguage,
    filePath: string,
  ): RawSignatureMap {

    // Empty source = new file (no old sigs) or deleted file (no new sigs)
    if (!source || source.trim() === '') {
      return new Map();
    }

    let tree: Tree | null = null;

    try {
      tree = this.parser!.parse(source);

      // parse() returns null if no language is set or parsing was cancelled
      if (!tree) {
        console.warn(`[ASTMapper] Parser returned null for "${filePath}" — skipping`);
        return new Map();
      }

      // tree-sitter never throws, but a root ERROR node means the file
      // is syntactically broken enough that signatures would be unreliable
      if (tree.rootNode.hasError) {
        console.warn(
          `[ASTMapper] Parse errors in "${filePath}" — signatures may be incomplete`
        );
        // We continue rather than bail — partial results are better than none
        // The classifier will handle missing signatures gracefully
      }

      const rawMap = this.dispatch(tree, ext, lang);

      // Inject filePath using O(1) Key Routing
      for (const [key, sig] of rawMap.entries()) {
        // If the key does NOT contain a colon, it is a FunctionSignature.
        if (!key.includes(':')) {
          (sig as FunctionSignature).filePath = filePath;
        }
      }

      return rawMap;

    } finally {
      // CRITICAL: always free WASM-allocated tree memory.
      // Runs even if dispatch() throws — that is the entire point of finally.
      tree?.delete();
    }
  }

  // ── 5. Language dispatch ───────────────────────────────────────────────────

  /**
   * Routes the parsed tree to the correct language translator.
   * Returns a Map<sigName, AnySignature>.
   *
   * Adding a new language:
   *  1. npm install tree-sitter-{language}
   *  2. Add .wasm to grammars/ via copy-grammars script
   *  3. Add case here
   *  4. Add translator in translators/
   *  5. Update constants.ts SUPPORTED_EXTENSIONS and EXTENSION_TO_LANGUAGE
   */
  private dispatch(
    tree: Tree,
    ext:  string,
    lang: WasmLanguage,
  ): RawSignatureMap {
    switch (ext) {
      case 'ts':
      case 'tsx':
      case 'js':
      case 'jsx':
        // TypeScript grammar handles JS too — same node types for shared syntax
        return extractTSSignatures(tree, lang);

      case 'py':
        return extractPySignatures(tree, lang);

      case 'go':
        return extractGoSignatures(tree, lang);

      case 'java':
        return extractJavaSignatures(tree, lang);

      case 'rs':
        return extractRustSignatures(tree, lang);

      default:
        return new Map();
    }
  }

  // ── 6. Grammar loader with deduplication ──────────────────────────────────

  private async getLanguage(code: string): Promise<WasmLanguage> {
    // Already loaded — return instantly
    if (this.languages.has(code)) {
      return this.languages.get(code)!;
    }

    // Currently loading — wait for the in-flight promise
    // This prevents multiple simultaneous WASM loads for the same grammar
    if (this.loadingLanguages.has(code)) {
      return this.loadingLanguages.get(code)!;
    }

    // First request for this grammar — start the load
    const loadPromise = this.loadGrammar(code).finally(() => {
      // Clean up in-flight map after settling — success or failure
      // Prevents the map from holding stale rejected promises
      this.loadingLanguages.delete(code);
    });

    this.loadingLanguages.set(code, loadPromise);
    return loadPromise;
  }

  private async loadGrammar(code: string): Promise<WasmLanguage> {
    const wasmFilename = `tree-sitter-${code}.wasm`;

    // Resolve relative to THIS FILE not process.cwd()
    // process.cwd() breaks when the package is installed globally or as a library
    // __dirname always points to the compiled output directory
    const wasmPath = path.resolve(__dirname, '..', '..', 'grammars', wasmFilename);

    try {
      const lang = await WasmLanguage.load(wasmPath);
      this.languages.set(code, lang);
      return lang;
    } catch (error: any) {
      throw new Error(
        `[ASTMapper] Failed to load grammar "${code}" from ${wasmPath}. ` +
        `Ensure "npm run copy-grammars" has been run. ` +
        `Original error: ${error.message}`
      );
    }
  }

  // ── 7. Helpers ─────────────────────────────────────────────────────────────

  private skipped(
    file:       string,
    reason:     string,
    language?:  Language,
  ): ParseResult {
    return {
      file,
      language:   language ?? 'typescript',
      oldSigs:    new Map(),
      newSigs:    new Map(),
      skipped:    true,
      skipReason: reason,
    };
  }
  /**
   * Maps grammar codes to the correct WASM filename.
   * tsx uses the typescript grammar — tree-sitter-typescript ships both.
   * jsx uses the javascript grammar — same package.
   */
  resolveGrammarCode(ext: string): string {
    const map: Record<string, string> = {
      ts:   'typescript',
      tsx:  'typescript', // NOT 'tsx' — tree-sitter-typescript ships tsx grammar
      js:   'javascript',
      jsx:  'javascript', // NOT 'jsx' — tree-sitter-javascript ships jsx grammar
      py:   'python',
      go:   'go',
      java: 'java',
      rs:   'rust',
    };
    return map[ext] ?? ext;
  }
}