// zfb build writes this module before Wrangler bundles the Worker entrypoint.
import generatedWorkerModule from "../dist/_worker.js";

import { createRouteAwareWorker } from "./route-aware-dispatch.mjs";

export default createRouteAwareWorker(generatedWorkerModule);
