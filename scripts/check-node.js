#!/usr/bin/env node
// Enforce Node 22.x at runtime — guards against ABI mismatch with native deps.
const major = process.versions.node.split(".").map(Number)[0];
if (major !== 22) {
  console.error(
    `ERROR: Node 22.x required (got ${process.version}). Run: nvm use 22`,
  );
  process.exit(1);
}
