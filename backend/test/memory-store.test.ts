import { MemoryStore } from '../src/storage/memory.js';
import { orderFlowSuite } from './order-flows.js';

orderFlowSuite('memory store', async () => new MemoryStore());
