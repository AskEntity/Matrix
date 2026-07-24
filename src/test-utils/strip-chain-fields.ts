import type { Event } from "../events.ts";

/**
 * Drop the `eid` / `parentEid` chain fields that `EventStore` stamps onto
 * events at write time, so a test can deep-compare what it read back against
 * the literals it appended.
 *
 * `append` / `appendBatch` do NOT write those fields onto the caller's object
 * (they build a separate persisted form — see `withChainFields` in
 * event-store.ts), so `expect(store.read(id)).toEqual([literal])` would report
 * two extra keys on every event. Stripping keeps the assertion exact for every
 * OTHER field; the chain fields have their own coverage in event-id.test.ts.
 */
export function stripChainFields(events: Event[]): Event[] {
	return events.map(
		({ eid: _eid, parentEid: _parentEid, ...rest }) => rest as Event,
	);
}
