// Test reporters do not create their destination directories.
for (const dir of ['artifacts/junit', 'artifacts/coverage']) require('node:fs').mkdirSync(dir, { recursive: true });
