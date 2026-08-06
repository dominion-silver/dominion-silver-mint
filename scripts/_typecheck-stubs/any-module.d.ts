// Stub for the ONE package whose bundled .d.ts fails to PARSE under this repo's TypeScript
// (@solana/spl-token-group's nested @solana/codecs-data-structures). skipLibCheck skips type CHECKING,
// not parsing, so without this tsc aborts before reaching scripts/ and reports success having checked
// nothing. That false green is what let a five-argument call to a six-argument function ship (round 3 P0).
declare const anything: any;
export = anything;
