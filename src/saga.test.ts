import { describe, test, expect, mock, beforeAll } from "bun:test";
import { z } from "zod";
import { Saga } from "./saga";
import { runTaskListOnce, quickAddJob, TaskList, run } from "graphile-worker";
import { Pool } from "pg";

const pgPool = new Pool({ connectionString: process.env.DATABASE_URL });

describe("graphile-saga", () => {
  beforeAll(async () => {
    // This forces migraitons to run
    const runner = await run(
      { pgPool },
      {
        nothing: async () => {},
      }
    );
    await runner.stop();
    await pgPool.query("truncate graphile_worker._private_jobs;");
  });

  test("saga.getTaskList should return a task list with the initial task, all the steps, and the cancel steps", async () => {
    const sagaName = "test-get-task-list";

    const saga = new Saga(sagaName, z.object({ name: z.string() }))
      .addStep({
        name: "step1",
        run: async () => {},
        cancel: async (payload) => {},
      })
      .addStep({
        name: "step2",
        run: async () => {},
        cancel: async () => {},
      });

    const taskList = saga.getTaskList();

    expect(taskList).toHaveProperty(`${sagaName}`);
    expect(taskList).toHaveProperty(`${sagaName}|step1`);
    expect(taskList).toHaveProperty(`${sagaName}|step1|cancel`);
    expect(taskList).toHaveProperty(`${sagaName}|step2`);
    expect(taskList).toHaveProperty(`${sagaName}|step2|cancel`);
  });

  test("running the saga should run the first function", async () => {
    const sagaName = "test-run-saga";

    const fn = mock(async () => {});

    const saga = new Saga(sagaName, z.object({ name: z.string() })).addStep({
      name: "step1",
      run: fn,
    });

    const taskList = saga.getTaskList() as TaskList;

    await quickAddJob({ pgPool }, sagaName, { name: "test" });

    const client = await pgPool.connect();
    await runTaskListOnce({ pgPool }, taskList, client);
    await client.release();

    expect(fn).toHaveBeenCalled();
  });

  test("running the first function should queue the second function with prior results", async () => {
    const sagaName = "test-run-saga-two";

    const fn2 = mock(async (shouldBeResult1: string) => {});

    const saga = new Saga(sagaName, z.object({ name: z.string() }))
      .addStep({
        name: "step1",
        run: async (initialPayload, priorResults, helpers) => {
          return "result1";
        },
      })
      .addStep({
        name: "step2",
        run: async (payload, previousResults) => {
          return fn2(previousResults.step1);
        },
      });

    const taskList = saga.getTaskList() as TaskList;

    await quickAddJob({ pgPool }, sagaName, { name: "test" });

    const client = await pgPool.connect();
    // Need to run once for each step
    await runTaskListOnce({ pgPool }, taskList, client);
    await runTaskListOnce({ pgPool }, taskList, client);
    // And release
    await client.release();

    expect(fn2).toHaveBeenCalledWith("result1");
  });

  test("calling helpers.cancel should run the cancel function for the step before", async () => {
    const sagaName = "test-cancel-saga";

    let cancelPayload: string | undefined = undefined;
    let cancelPreviousResults: Record<string, any> | undefined = undefined;
    let cancelRunResult: string | undefined = undefined;

    const fn1Cancel = mock(
      async (initialPayload, previousResults, runResult) => {
        cancelPayload = initialPayload;
        cancelPreviousResults = previousResults;
        cancelRunResult = runResult;
        return true;
      }
    );

    const saga = new Saga(sagaName, z.string())
      .addStep({
        name: "step1",
        run: async (initialPayload, priorResults, helpers) => {
          return "result1";
        },
        cancel: fn1Cancel,
      })
      .addStep({
        name: "step2",
        run: async (payload, previousResults, helpers) => {
          return helpers.cancel("No reason");
        },
      });

    const taskList = saga.getTaskList() as TaskList;

    await quickAddJob({ pgPool }, sagaName, "hello");

    const client = await pgPool.connect();
    // First step
    await runTaskListOnce({ pgPool }, taskList, client);
    // Second step which throws cancel
    await runTaskListOnce({ pgPool }, taskList, client);
    // Third step which is the first steps cancel
    await runTaskListOnce({ pgPool }, taskList, client);
    // And release
    await client.release();

    expect(fn1Cancel).toHaveBeenCalled();

    expect(cancelPayload as any).toEqual("hello");
    expect(cancelPreviousResults as any).toEqual({ step1: "result1" });
    expect(cancelRunResult as any).toEqual("result1");
  });

  test("calling helpers.cancel should cascade up the cancel functions, skipping steps if a cancel step is missing", async () => {
    const sagaName = "test-cancel-saga-cascade";

    const fn1Cancel = mock(
      async (initialPayload, previousResults, runResult) => {
        return true;
      }
    );

    const fn2Cancel = mock(
      async (initialPayload, previousResults, runResult) => {
        return true;
      }
    );

    const saga = new Saga(sagaName, z.string())
      .addStep({
        name: "step1",
        run: async (initialPayload, priorResults, helpers) => {
          return "result1";
        },
        cancel: fn1Cancel,
      })
      .addStep({
        name: "step2",
        run: async (payload, previousResults, helpers) => {
          return "result2";
        },
        cancel: fn2Cancel,
      })
      .addStep({
        name: "step3",
        run: async (payload, previousResults, helpers) => {
          return helpers.cancel("No reason");
        },
      });

    const taskList = saga.getTaskList() as TaskList;

    await quickAddJob({ pgPool }, sagaName, "hello");

    const client = await pgPool.connect();
    // First step
    await runTaskListOnce({ pgPool }, taskList, client);
    // Second step
    await runTaskListOnce({ pgPool }, taskList, client);
    // Third step which cancels
    await runTaskListOnce({ pgPool }, taskList, client);
    // Fourth step which is the second steps cancel
    await runTaskListOnce({ pgPool }, taskList, client);
    // Fifth step which is the first steps cancel
    await runTaskListOnce({ pgPool }, taskList, client);
    // And release
    await client.release();

    expect(fn2Cancel).toHaveBeenCalled();
    expect(fn1Cancel).toHaveBeenCalled();
  });

  test("calling helpers.cancel should cascade up the cancel functions, skipping steps if a cancel step is missing", async () => {
    const sagaName = "test-cancel-saga-cascade";

    const fn1Cancel = mock(
      async (initialPayload, previousResults, runResult) => {
        return true;
      }
    );

    const fn3Cancel = mock(
      async (initialPayload, previousResults, runResult) => {
        return true;
      }
    );

    const saga = new Saga(sagaName, z.string())
      .addStep({
        name: "step1",
        run: async (initialPayload, priorResults, helpers) => {
          return "result1";
        },
        cancel: fn1Cancel,
      })
      .addStep({
        // Step 2 has no cancel function
        name: "step2",
        run: async (payload, previousResults, helpers) => {
          return "result2";
        },
      })
      .addStep({
        name: "step3",
        run: async (payload, previousResults, helpers) => {
          return "result3";
        },
        cancel: fn3Cancel,
      })
      .addStep({
        name: "step4",
        run: async (payload, previousResults, helpers) => {
          return helpers.cancel("No reason");
        },
      });

    const taskList = saga.getTaskList() as TaskList;

    await quickAddJob({ pgPool }, sagaName, "hello");

    const client = await pgPool.connect();
    // First step
    await runTaskListOnce({ pgPool }, taskList, client);
    // Second step
    await runTaskListOnce({ pgPool }, taskList, client);
    // Third step
    await runTaskListOnce({ pgPool }, taskList, client);
    // Fourth step which cancels
    await runTaskListOnce({ pgPool }, taskList, client);
    // Fifth step which is the third steps cancel
    await runTaskListOnce({ pgPool }, taskList, client);
    // Sixth step which is the first steps cancel
    await runTaskListOnce({ pgPool }, taskList, client);
    // And release
    await client.release();

    expect(fn3Cancel).toHaveBeenCalled();
    expect(fn1Cancel).toHaveBeenCalled();
  });
});
