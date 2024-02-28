# graphile-saga

A TypeScript library for managing complex, multi-step processes with automatic rollback capabilities in the event of a failure.
Built on top of [`graphile-worker`](https://github.com/graphile/worker), and
[`graphile-worker-zod`](https://github.com/ben-pr-p/graphile-worker-zod), 
`graphile-saga` provides a robust solution for implementing the saga pattern with strong type safety and 
easy to implement cancellation semantics.

## Installation

To install `graphile-saga`, you can use `npm`, `yarn`, or `bun`:

```bash
bun add graphile-saga
```

## Usage

To create a saga, first define the initial payload schema with `zod`, then use `new Saga` to define the saga steps. Each step can have a `run` function and an optional `cancel` function for rollback purposes.

```typescript
// makeSeservationSaga.ts
import { Saga } from 'graphile-saga';
import { z } from 'zod';
import { hotelService, flightService, carService } from './travelServices';

// Define your saga
const makeReservationSaga = new Saga('makeReservation', z.object({
  hotelId: z.number(),
  airlineId: z.number(),
  carId: z.number(),
}))
  .addStep({
    name: 'reserveHotel',
    run: async (initialPayload, priorResults, helpers) => {
      const hotelConfirmation = await hotelService.reserve(initialPayload.hotelId);
      return { hotelConfirmation };
    },
    cancel: async (initialPayload, priorResults, runResult, helpers) => {
      await hotelService.cancelReservation(runResult.hotelConfirmation);
    },
  })
  .addStep({
    name: 'reserveFlight',
    run: async (initialPayload, priorResults, helpers) => {
      const flightConfirmation = await flightService.bookFlight(initialPayload.airlineId);
      return { flightConfirmation };
    },
    cancel: async (initialPayload, priorResults, runResult, helpers) => {
      await flightService.cancelFlight(runResult.flightConfirmation);
    },
  })
  .addStep({
    name: 'reserveCar',
    run: async (initialPayload, priorResults, helpers) => {
      const carAvailable = await carService.checkAvailability(initialPayload.carId);
      if (!carAvailable) {
        // Cancel throws a custom error which triggers rollbacks all the way up
        helpers.cancel('Car not available');
      }
      const carConfirmation = await carService.reserveCar(initialPayload.carId);
      return { carConfirmation };
    },
    cancel: async (initialPayload, priorResults, runResult, helpers) => {
      await carService.cancelCarReservation(runResult.carConfirmation);
    },
  });
```

Not every step needs to have a `cancel` function. If a step does not have a `cancel` function, the saga will automatically progress
rolling back to the previous step.

```typescript
// worker.ts
import { makeReservationSaga } from './makeReservationSaga';

const taskList = {
  // this has all of your regular graphile worker tasks
  // just add your saga task lists to it
  ...makeReservationSaga.getTaskList()
  ...otherSaga.taskList()
} as const;
```

Then you can queue a `makeReservation` job by any allowed method, and the whole saga will run.

In addition to implementing things that might be cancellable, graphile-saga can also help you avoid retrying things that
might be expensive, computationally or monetarily:
```typescript
import { makeAi } from 'zod-ai';

const client = new OpenAI(process.env.OPENAI_API_KEY);

const ai = makeAi({
  client,
  model: "gpt-4",
});

const draftEmailFunction = ai(
  z
    .function()
    .args(z.string())
    .returns(z.object({
      subject: z.string(),
      body: z.string(),
    }))
    .describe(
      "Draft an email to a recipient for a given purpose."
    )
)

const haveAiWriteEmailSaga = new Saga('haveAiWriteEmail', z.object({
  recipient: z.string().email(),
  purpose: z.string(),
}))
  .addStep({
    name: 'draftEmail',
    run: async (initialPayload, priorResults, helpers) => {
      // Expensive gpt-4 call
      const { subject, body } = await draftEmailFunction(initialPayload.purpose);
      return { subject, body };
    }
  })
  .addStep({
    name: 'sendEmail',
    run: async (initialPayload, priorResults, helpers) => {
      // Email sending that could fail for all sorts of good, retryable reasons
      await mailchimp.sendEmail(initialPayload.email);
    }
  })
```

## Danger

We have no way of preventing you from queueing a saga task directly, since it's just a regular graphile worker task.
However, if you do this, the job will fail, because we intercept and add extra properties to the payload 
to make the continuation and rollback semantics work correctly.

To make this easier to avoid (and to cut down on some Typescript noise) we provide an `AddJobFn` type that excludes the
ability to queue a saga job directly.

```typescript
import { createTask, createTaskList } from 'graphile-worker-zod';
import { run, TaskList } from 'graphile-worker';
import { AddJobFn } from 'graphile-saga';
import { makeReservationSaga } from './makeReservationSaga';
import { z } from 'zod'

const sendEmail = createTask(
  z.object({
    email: z.string().email(),
  }),
  async (payload, jobHelpers) => {
    // payload is typed as { email: string }
    // send email
  }
)

const taskList = {
  sendEmail,
  ...makeReservationSaga.getTaskList()
} as const; // you need this as const declaration!!!

let runner: Runner;

export const startWorker = async () => {
  runner = await run({
    pgPool: pool // definition not shown,
    taskList: taskList as TaskList // cast required because type has extra info graphile-worker doesn't want
  })
}

/**
 * If graphile-worker-zod's AddJobFn was used, the typeof addJob would be:
 * (taskName: "sendEmail", payload: { email: string }) => Promise<Job>
 * (taskName: "makeReservation", payload: { hotelId: number; airlineId: number; carId: number; }) => Promise<Job>
 * (taskName: "makeReservation|reserveHotel", payload: { hotelId: number; airlineId: number; carId: number; }) => Promise<Job>
 * (taskName: "makeReservation|reserveHotel|cancel", ...
 * (taskName: "makeReservation|reserveFlight, ...
 * ...
 * 
 * It's too much! With 'graphile-saga's AddJobFn you get just the first two.
 * 
 */
export const addJob: AddJobFn<typeof TaskList> = async (taskName, payload) => {
  if (!runner) {
    throw new Error('Add job called before worker started');
  }

  return runner.addJob(taskName, payload);
}
```

## Motivation

The saga pattern is a sequence of transactions that updates multiple services in a distributed system. If one transaction fails, the saga automatically executes compensating transactions to undo the changes made by the preceding successful transactions. `graphile-saga` leverages TypeScript's type system to ensure that each step of the saga receives the correct types for payloads and results, reducing the likelihood of runtime errors and making the code easier to reason about.

## Under The Hood

`graphile-saga` maps each step in a saga to specific task names that are used by `graphile-worker`. For a saga named `mySaga` with steps `step1`, `step2`, etc., the task names would be:

- `mySaga`: The initial task that starts the saga.
- `mySaga:step1`: The task corresponding to the first step of the saga.
- `mySaga:step1:cancel`: The task that handles cancellation of the first step, if defined.
- `mySaga:step2`: The task for the second step, and so on.

Each task is strongly typed, and the task list is automatically generated based on the saga definition, ensuring that all steps adhere to the defined types and logic.

`graphile-saga` also automates the process of queueing the next step in the saga, as well as any necessary cancellation steps. This ensures that you don't have to manually manage the flow of the saga or the rollback logic.

