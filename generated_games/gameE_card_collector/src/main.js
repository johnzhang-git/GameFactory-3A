// 3AGameFactory three.js host entry point for the card collector.
//
// The adapter-owned runtime framework is booted inside the gameplay
// package; this file only imports it and starts the game, keeping the
// host and the game as separate deliverables.
import { startCardCollector } from '@a3game/card-collector';

await startCardCollector();
