/**
 * Vector-driven tests for nextSessionState. The vectors live in
 * rpc-state-fold-vectors.json so downstream ports of the fold can run the
 * same cases.
 *
 * Vector semantics:
 * - input state = baseState overridden by vector.state
 * - vector.expected lists only the fields that must differ from the input
 *   state; a `null` value means the field becomes undefined. An empty
 *   `expected` asserts the fold returns the input state by reference.
 * - vector.expectedFullState replaces the whole comparison (used for
 *   session_changed).
 */

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { nextSessionState } from "../src/modes/rpc/rpc-state-fold.ts";
import type { RpcSessionState, RpcSocketBroadcastEvent } from "../src/modes/rpc/rpc-types.ts";

const __dirname = dirname(fileURLToPath(import.meta.url));

interface FoldVector {
	name: string;
	state?: Partial<RpcSessionState>;
	event: RpcSocketBroadcastEvent;
	expected?: Record<string, unknown>;
	expectedFullState?: RpcSessionState;
}

const fixture = JSON.parse(readFileSync(join(__dirname, "rpc-state-fold-vectors.json"), "utf-8")) as {
	baseState: RpcSessionState;
	vectors: FoldVector[];
};

describe("nextSessionState vectors", () => {
	for (const vector of fixture.vectors) {
		it(vector.name, () => {
			const state: RpcSessionState = { ...fixture.baseState, ...vector.state };
			const result = nextSessionState(state, vector.event);

			if (vector.expectedFullState) {
				expect(result).toEqual(vector.expectedFullState);
				return;
			}

			const expected: Record<string, unknown> = { ...state };
			for (const [field, value] of Object.entries(vector.expected ?? {})) {
				if (value === null) {
					expected[field] = undefined;
				} else {
					expected[field] = value;
				}
			}
			expect(result).toEqual(expected);

			if (Object.keys(vector.expected ?? {}).length === 0) {
				expect(result).toBe(state);
			} else {
				expect(result).not.toBe(state);
			}
		});
	}
});
