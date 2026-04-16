/**
 * src/tracer/index.ts
 *
 * PUBLIC API for the Lazy Graph tracer module.
 * Re-exports the scanner (Phase 2) and tracer (Phase 3) alongside
 * the factory function for default configuration.
 */

export { JITScanner, createDefaultTracerConfig } from './scanner';
export { CallSiteTracer } from './tracer';
