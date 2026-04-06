// Quick smoke test: spawn worker pool, load data, run lm, check results
import { WorkerPool } from "../src/engine/workerPool.js";
import { createSessionStore, registerHandle } from "../src/engine/session.js";

async function main() {
  console.log("=== StatTools Smoke Test ===\n");

  // 1. Create session
  const session = createSessionStore("smoke_test_001");
  const pool = new WorkerPool(session, { recycleAfterCalls: 50 });

  try {
    // 2. Start pool
    console.log("Starting worker pool...");
    await pool.start();
    console.log("✓ Pool started:", pool.getStatus());

    // 3. List objects (should be empty)
    const listResp = await pool.call("list_objects", {});
    console.log("\n✓ list_objects:", JSON.stringify(listResp.result).slice(0, 200));

    // 4. Load mtcars
    console.log("\nLoading /tmp/test_mtcars.csv...");
    const loadResp = await pool.call("load_data", {
      file_path: "/tmp/test_mtcars.csv",
      name: "data_1",
    });

    if (loadResp.error) {
      console.error("✗ load_data failed:", loadResp.error);
      process.exit(1);
    }

    // Register handle
    if (loadResp.objectsCreated) {
      for (const obj of loadResp.objectsCreated) {
        registerHandle(session, obj, pool.getStatus().activeWorkerId!, "stat_load_data");
      }
    }

    const result = loadResp.result as Record<string, unknown>;
    const dims = result.dimensions as Record<string, number>;
    console.log(`✓ Loaded: ${dims.rows} rows × ${dims.cols} cols`);

    // 5. Fit linear model
    console.log("\nFitting lm(mpg ~ wt + hp)...");
    const lmResp = await pool.call("call", {
      package: "stats",
      function: "lm",
      args: { formula: "mpg ~ wt + hp", data: "data_1" },
    });

    if (lmResp.error) {
      console.error("✗ lm failed:", lmResp.error);
      process.exit(1);
    }

    // Register model handle
    if (lmResp.objectsCreated) {
      for (const obj of lmResp.objectsCreated) {
        registerHandle(session, obj, pool.getStatus().activeWorkerId!, "stat_call");
      }
    }

    const lmResult = lmResp.result as Record<string, unknown>;
    console.log(`✓ R² = ${lmResult.r_squared}`);
    console.log(`  Coefficients:`, JSON.stringify(lmResult.coefficients).slice(0, 300));

    if (lmResp.warnings && lmResp.warnings.length > 0) {
      console.log(`  Warnings: ${lmResp.warnings.join(", ")}`);
    }

    // 6. Check session state
    const handles = session.getState().handles;
    console.log(`\n✓ Session has ${handles.size} handles:`);
    for (const [id, h] of handles) {
      console.log(`  ${id}: ${h.summary} [${h.persistenceClass}]`);
    }

    // 7. Schema extraction
    console.log("\nExtracting schema for stats::t.test...");
    const schemaResp = await pool.call("schema", {
      package: "stats",
      function: "t.test",
    });

    if (schemaResp.error) {
      console.error("✗ schema failed:", schemaResp.error);
    } else {
      const schema = schemaResp.result as Record<string, unknown>;
      const props = (schema.schema as Record<string, unknown>)?.properties as Record<string, unknown>;
      console.log(`✓ t.test has ${Object.keys(props || {}).length} parameters`);
      console.log(`  Parameters: ${Object.keys(props || {}).join(", ")}`);
    }

    console.log("\n=== All smoke tests passed ===");
  } catch (err) {
    console.error("✗ Test failed:", err);
    process.exit(1);
  } finally {
    await pool.stop();
  }
}

main();
