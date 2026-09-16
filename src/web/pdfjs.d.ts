// pdf.js ships no types for its ESM entry points; the importer only touches a handful
// of documented methods and validates everything it reads.
declare module 'pdfjs-dist/build/pdf.mjs';
declare module 'pdfjs-dist/legacy/build/pdf.mjs';
