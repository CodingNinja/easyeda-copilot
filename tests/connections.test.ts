import assert from 'node:assert/strict';
import test from 'node:test';
import {
    buildConnectionIndex,
    collectWireCluster,
    describeConnectionAt,
    findWiresAtPoint,
    segmentEndpointKeys,
    type ConnectionsPageData,
    type PointSymbolData,
    type WireData,
    type WireLabelData,
} from '../src/eda/connections-core.ts';
import { pointKey, pointOnSegment, to2 } from '../src/eda/geometry.ts';

function wire(id: string, net: string, ...segments: number[][]): WireData {
    return { id, net, segments };
}

function flag(id: string, name: string, x: number, y: number): PointSymbolData {
    return { id, type: 'flag', name, x, y, direction: null };
}

function port(id: string, name: string, x: number, y: number, direction: PointSymbolData['direction'] = null): PointSymbolData {
    return { id, type: 'port', name, x, y, direction };
}

function label(id: string, name: string, wireId: string): WireLabelData {
    return { id, name, wireId };
}

function page(partial: Partial<ConnectionsPageData>): ConnectionsPageData {
    return { wires: [], pointSymbols: [], wireLabels: [], ...partial };
}

function names(symbols: { type: string; name: string }[]) {
    return symbols.map(s => `${s.type}:${s.name}`);
}

test('geometry: to2 snaps to the 5-unit grid and pointKey uses it', () => {
    assert.equal(to2(102), 100);
    assert.equal(to2(103), 105);
    assert.equal(pointKey(102, 47.6), '100,50');
});

test('geometry: pointOnSegment is inclusive of ends and rejects off-line points', () => {
    const seg = [0, 0, 100, 0];
    assert.equal(pointOnSegment({ x: 0, y: 0 }, seg), true);
    assert.equal(pointOnSegment({ x: 100, y: 0 }, seg), true);
    assert.equal(pointOnSegment({ x: 50, y: 0 }, seg), true);
    assert.equal(pointOnSegment({ x: 150, y: 0 }, seg), false);
    assert.equal(pointOnSegment({ x: 50, y: 5 }, seg), false);
    assert.equal(pointOnSegment({ x: 50, y: 0 }, [0, 0]), false);
});

test('segmentEndpointKeys lists both ends of every segment', () => {
    assert.deepEqual(segmentEndpointKeys([[0, 0, 10, 0], [10, 0, 10, 20]]), ['0,0', '10,0', '10,0', '10,20']);
});

test('label-only wire reports a single label', () => {
    const index = buildConnectionIndex(page({
        wires: [wire('w1', 'SIG_A', [0, 0, 20, 0])],
    }));
    const result = describeConnectionAt(index, 0, 0);
    assert.equal(result.wire_id, 'w1');
    assert.equal(result.wire_net, 'SIG_A');
    assert.deepEqual(names(result.symbols), ['label:SIG_A']);
    // The label is the wire's own net attribute, so its id is the wire id.
    assert.equal(result.symbols[0].primitive_id, 'w1');
});

test('flag on the far end of a stub reports a single flag', () => {
    const index = buildConnectionIndex(page({
        wires: [wire('w1', '', [0, 0, 0, 10])],
        pointSymbols: [flag('f1', 'GND', 0, 10)],
    }));
    const result = describeConnectionAt(index, 0, 0);
    assert.deepEqual(names(result.symbols), ['flag:GND']);
});

test('flag and label with the same name are both reported (not merged by name)', () => {
    const index = buildConnectionIndex(page({
        wires: [wire('w1', 'GND', [0, 0, 0, 10])],
        pointSymbols: [flag('f1', 'GND', 0, 10)],
    }));
    const result = describeConnectionAt(index, 0, 0);
    assert.deepEqual(names(result.symbols).sort(), ['flag:GND', 'label:GND']);
});

test('flag and label with different names are both reported so the caller sees the mismatch', () => {
    const index = buildConnectionIndex(page({
        wires: [wire('w1', 'AGND', [0, 0, 0, 10])],
        pointSymbols: [flag('f1', 'GND', 0, 10)],
    }));
    const result = describeConnectionAt(index, 0, 0);
    assert.deepEqual(names(result.symbols).sort(), ['flag:GND', 'label:AGND']);
});

test('flag placed directly on the pin with no wire is still reported', () => {
    const index = buildConnectionIndex(page({
        pointSymbols: [flag('f1', 'GND', 0, 0)],
    }));
    const result = describeConnectionAt(index, 0, 0);
    assert.equal(result.wire_id, null);
    assert.equal(result.wire_net, null);
    assert.deepEqual(names(result.symbols), ['flag:GND']);
});

test('unconnected pin with nothing near it reports an empty connection', () => {
    const index = buildConnectionIndex(page({
        wires: [wire('w1', '', [100, 100, 120, 100])],
        pointSymbols: [flag('f1', 'GND', 200, 200)],
    }));
    assert.deepEqual(describeConnectionAt(index, 0, 0), { wire_id: null, wire_net: null, symbols: [] });
});

test('two-segment cluster finds a label on the far wire and a port at the far endpoint', () => {
    const index = buildConnectionIndex(page({
        wires: [
            wire('w1', '', [0, 0, 20, 0]),
            wire('w2', 'SIG', [20, 0, 20, 30]),
        ],
        pointSymbols: [port('p1', 'SIG', 20, 30, 'output')],
    }));
    const result = describeConnectionAt(index, 0, 0);
    assert.equal(result.wire_id, 'w1');
    assert.deepEqual(names(result.symbols).sort(), ['label:SIG', 'port:SIG']);
    assert.equal(result.symbols.find(s => s.type === 'port')?.direction, 'output');
});

test('T-junction: a wire whose endpoint lands on the interior of another wire joins the cluster', () => {
    const index = buildConnectionIndex(page({
        wires: [
            wire('trunk', '', [0, 0, 100, 0]),
            wire('branch', '', [50, 0, 50, 40]),
        ],
        pointSymbols: [flag('f1', 'N', 50, 40)],
    }));
    const cluster = collectWireCluster(index, 'trunk');
    assert.deepEqual(cluster.wireIds.sort(), ['branch', 'trunk']);
    assert.deepEqual(names(describeConnectionAt(index, 0, 0).symbols), ['flag:N']);
});

test('pin sitting on the interior of a wire segment is treated as connected to it', () => {
    const index = buildConnectionIndex(page({
        wires: [wire('w1', 'N', [0, 0, 100, 0])],
    }));
    assert.deepEqual(findWiresAtPoint(index, 50, 0), ['w1']);
    assert.equal(describeConnectionAt(index, 50, 0).wire_id, 'w1');
});

test('symbol dropped mid-segment is found even though it is not at an endpoint', () => {
    const index = buildConnectionIndex(page({
        wires: [wire('w1', '', [0, 0, 100, 0])],
        pointSymbols: [flag('f1', 'N', 60, 0)],
    }));
    assert.deepEqual(names(describeConnectionAt(index, 0, 0).symbols), ['flag:N']);
});

test('a symbol reachable from two wires is reported once (dedupe by primitive id)', () => {
    const index = buildConnectionIndex(page({
        wires: [
            wire('w1', '', [0, 0, 20, 0]),
            wire('w2', '', [20, 0, 40, 0]),
        ],
        pointSymbols: [flag('f1', 'N', 20, 0)],
    }));
    const result = describeConnectionAt(index, 0, 0);
    assert.equal(result.symbols.length, 1);
    assert.equal(result.symbols[0].primitive_id, 'f1');
});

test('multiple wires at the pin: first is used and the logger is told', () => {
    const messages: string[] = [];
    const index = buildConnectionIndex(page({
        wires: [
            wire('w1', 'N', [0, 0, 20, 0]),
            wire('w2', 'N', [0, 0, 0, 20]),
        ],
    }));
    const result = describeConnectionAt(index, 0, 0, m => messages.push(m));
    assert.equal(result.wire_id, 'w1');
    assert.equal(messages.length, 1);
    assert.match(messages[0], /2 wire primitives/);
});

test('wire_net: blank becomes null, EasyEDA auto-names are kept verbatim', () => {
    const index = buildConnectionIndex(page({
        wires: [
            wire('blank', '', [0, 0, 10, 0]),
            wire('auto', '$1N5', [100, 0, 110, 0]),
        ],
    }));
    assert.equal(describeConnectionAt(index, 0, 0).wire_net, null);
    assert.equal(describeConnectionAt(index, 100, 0).wire_net, '$1N5');
});

test('coordinates that differ by less than the grid still match', () => {
    const index = buildConnectionIndex(page({
        wires: [wire('w1', '', [0.4, -0.3, 20, 0])],
        pointSymbols: [flag('f1', 'N', 19.8, 0.2)],
    }));
    const result = describeConnectionAt(index, 0, 0);
    assert.equal(result.wire_id, 'w1');
    assert.deepEqual(names(result.symbols), ['flag:N']);
});

// ---------------------------------------------------------------------------
// Restyle planning
// ---------------------------------------------------------------------------

import {
    defaultFlagKind,
    freeEndsOfCluster,
    collectWireCluster as clusterOf,
    netMembers,
    outwardDirection,
    pinNetView,
    planRestyle,
    stubLine,
    symbolRotation,
    verifyRestyleOutcome,
    type ConnectionIndex,
    type ConnectionStyle,
    type PinConnection,
    type PinSite,
} from '../src/eda/connections-core.ts';

const identityY = (y: number) => y;
const flipY = (y: number) => -y;

function plan(args: {
    index: ConnectionIndex;
    site: PinSite;
    style: ConnectionStyle;
    signalName?: string;
    pinKeys?: string[];
    designator?: string;
    pin?: string | number;
}) {
    const connection: PinConnection = describeConnectionAt(args.index, args.site.x, args.site.y);
    return planRestyle({
        item: { designator: args.designator ?? 'R1', pin_number: args.pin ?? 1, style: args.style },
        connection,
        signalName: args.signalName ?? (connection.symbols[0]?.name ?? ''),
        site: args.site,
        index: args.index,
        pinKeys: new Set([pointKey(args.site.x, args.site.y), ...(args.pinKeys ?? [])]),
        normY: identityY,
    });
}

test('defaultFlagKind: PGND → ProtectGround, other GND → Ground, rails → Power', () => {
    assert.equal(defaultFlagKind('PGND'), 'ProtectGround');
    assert.equal(defaultFlagKind('SPOC1_PGND_R'), 'ProtectGround');
    assert.equal(defaultFlagKind('GND'), 'Ground');
    assert.equal(defaultFlagKind('agnd'), 'Ground');
    assert.equal(defaultFlagKind('VCC1_3V3'), 'Power');
    assert.equal(defaultFlagKind('VBAT_PWR'), 'Power');
});

test('outwardDirection follows the place-net thresholds and honours normY', () => {
    assert.deepEqual(outwardDirection(0, identityY), { dx: 1, dy: 0 });
    assert.deepEqual(outwardDirection(90, identityY), { dx: 0, dy: 1 });
    assert.deepEqual(outwardDirection(180, identityY), { dx: -1, dy: 0 });
    assert.deepEqual(outwardDirection(270, identityY), { dx: 0, dy: -1 });
    assert.deepEqual(outwardDirection(90, flipY), { dx: 0, dy: -1 });
    assert.deepEqual(outwardDirection(-90, identityY), { dx: 0, dy: -1 });
});

test('stubLine: 10-unit stub from the pin in the outward direction, on the grid', () => {
    assert.deepEqual(stubLine({ x: 100, y: 50, rotation: 0 }, identityY), [100, 50, 110, 50]);
    assert.deepEqual(stubLine({ x: 100, y: 50, rotation: 90 }, identityY), [100, 50, 100, 60]);
    assert.deepEqual(stubLine({ x: 100, y: 50, rotation: 180 }, identityY), [100, 50, 90, 50]);
    assert.deepEqual(stubLine({ x: 100, y: 50, rotation: 270 }, identityY), [100, 50, 100, 40]);
    assert.deepEqual(stubLine({ x: 101, y: 49, rotation: 0 }, identityY), [100, 50, 110, 50]);
});

test('symbolRotation points the symbol pin back at the wire (measured on the scratch page)', () => {
    const left = { dx: -1, dy: 0 };
    const right = { dx: 1, dy: 0 };
    const up = { dx: 0, dy: 1 };
    const down = { dx: 0, dy: -1 };
    // Hand-placed reference: Netport (In) at a left wire end → rotation 0; Netport (Out) at a right end → 0.
    assert.equal(symbolRotation(left, 'port', undefined, identityY, 'input'), 0);
    assert.equal(symbolRotation(right, 'port', undefined, identityY, 'output'), 0);
    assert.equal(symbolRotation(right, 'port', undefined, identityY, 'bidirectional'), 0);
    assert.equal(symbolRotation(right, 'port', undefined, identityY, 'input'), 180);
    assert.equal(symbolRotation(left, 'port', undefined, identityY, 'output'), 180);
    assert.equal(symbolRotation(up, 'port', undefined, identityY, 'input'), 270);
    assert.equal(symbolRotation(up, 'port', undefined, identityY, 'output'), 90);
    // Flags: Power stands above an upward stub, Ground hangs below a downward stub.
    assert.equal(symbolRotation(up, 'flag', 'Power', identityY), 0);
    assert.equal(symbolRotation(down, 'flag', 'Ground', identityY), 0);
    assert.equal(symbolRotation(down, 'flag', 'ProtectGround', identityY), 0);
    assert.equal(symbolRotation(down, 'flag', 'Power', identityY), 180);
    assert.equal(symbolRotation(right, 'flag', 'Power', identityY), 270);
    assert.equal(symbolRotation(right, 'flag', 'Ground', identityY), 90);
    assert.equal(symbolRotation(up, 'label', undefined, identityY), 0);
});

test('freeEndsOfCluster: excludes pins and shared junctions, reports outward direction', () => {
    const index = buildConnectionIndex(page({
        wires: [
            wire('w1', 'N', [0, 0, 20, 0]),
            wire('w2', 'N', [20, 0, 20, 30]),
        ],
    }));
    const ends = freeEndsOfCluster(index, clusterOf(index, 'w1'), new Set(['0,0']));
    assert.deepEqual(ends.map(e => [e.x, e.y, e.dir.dx, e.dir.dy]), [[20, 30, 0, 1]]);
});

test('plan: label → output port goes to the free end, removes the label', () => {
    const index = buildConnectionIndex(page({
        wires: [wire('w1', 'SIG_A', [0, 0, 0, 20])],
    }));
    const result = plan({ index, site: { x: 0, y: 0, rotation: 90 }, style: { symbol: 'port', direction: 'output' } });
    assert.equal(result.ok, true);
    if (!result.ok) return;
    assert.equal(result.plan.net, 'SIG_A');
    assert.equal(result.plan.stub, null);
    assert.deepEqual(result.plan.remove.map(s => s.primitive_id), ['w1']);
    assert.deepEqual(result.plan.create, {
        type: 'port', name: 'SIG_A', x: 0, y: 20, rotation: 90, direction: 'output',
    });
});

test('plan: flag on GND net picks the Ground kind and is placed where the removed port was', () => {
    const index = buildConnectionIndex(page({
        wires: [wire('w1', '', [0, 0, 0, -20])],
        pointSymbols: [port('p1', 'GND', 0, -20)],
    }));
    const result = plan({ index, site: { x: 0, y: 0, rotation: 270 }, style: { symbol: 'flag' } });
    assert.equal(result.ok, true);
    if (!result.ok) return;
    assert.equal(result.plan.create?.flagKind, 'Ground');
    assert.equal(result.plan.create?.x, 0);
    assert.equal(result.plan.create?.y, -20);
    assert.equal(result.plan.create?.rotation, 0);
    assert.deepEqual(result.plan.remove.map(s => s.primitive_id), ['p1']);
});

test('plan: keeps an existing symbol of the requested type and removes the duplicates', () => {
    const index = buildConnectionIndex(page({
        wires: [wire('w1', 'DUP', [0, 0, 0, 20])],
        pointSymbols: [port('p1', 'DUP', 0, 20)],
    }));
    const result = plan({ index, site: { x: 0, y: 0, rotation: 90 }, style: { symbol: 'label' } });
    assert.equal(result.ok, true);
    if (!result.ok) return;
    assert.equal(result.plan.keep?.primitive_id, 'w1');
    assert.equal(result.plan.create, null);
    assert.deepEqual(result.plan.remove.map(s => s.primitive_id), ['p1']);
});

test('plan: a port is kept only when its kind (In/Out/Bi) matches the request', () => {
    const index = buildConnectionIndex(page({
        wires: [wire('w1', '', [0, 0, 0, 20])],
        pointSymbols: [port('p1', 'X', 0, 20, 'output')],
    }));
    const sameKind = plan({ index, site: { x: 0, y: 0, rotation: 90 }, style: { symbol: 'port', direction: 'output' } });
    assert.equal(sameKind.ok && sameKind.plan.keep?.primitive_id, 'p1');

    const otherKind = plan({ index, site: { x: 0, y: 0, rotation: 90 }, style: { symbol: 'port', direction: 'input' } });
    assert.equal(otherKind.ok && otherKind.plan.keep, null);
    assert.equal(otherKind.ok && otherKind.plan.create?.direction, 'input');
    assert.deepEqual(otherKind.ok ? otherKind.plan.remove.map(s => s.primitive_id) : [], ['p1']);
});

test('plan: NAME_MISMATCH when the wire carries two different names', () => {
    const index = buildConnectionIndex(page({
        wires: [wire('w1', 'AGND', [0, 0, 0, 20])],
        pointSymbols: [flag('f1', 'GND', 0, 20)],
    }));
    const result = plan({ index, site: { x: 0, y: 0, rotation: 90 }, style: { symbol: 'label' }, signalName: 'GND' });
    assert.equal(result.ok, false);
    if (result.ok) return;
    assert.equal(result.refusal.reason, 'NAME_MISMATCH');
    assert.match(result.refusal.detail, /2 different names \((GND, AGND|AGND, GND)\)/);
});

test('plan: NAME_MISMATCH when the symbol disagrees with the netlist', () => {
    const index = buildConnectionIndex(page({
        wires: [wire('w1', '', [0, 0, 0, 20])],
        pointSymbols: [flag('f1', 'X', 0, 20)],
    }));
    const result = plan({ index, site: { x: 0, y: 0, rotation: 90 }, style: { symbol: 'port' }, signalName: 'Y' });
    assert.equal(result.ok === false && result.refusal.reason, 'NAME_MISMATCH');
});

test('plan: PIN_UNCONNECTED for a pin with no wire and no symbol', () => {
    const index = buildConnectionIndex(page({}));
    const result = plan({ index, site: { x: 0, y: 0, rotation: 0 }, style: { symbol: 'flag' }, signalName: '' });
    assert.equal(result.ok === false && result.refusal.reason, 'PIN_UNCONNECTED');
});

test('plan: NO_NET_NAME when the only name is an EasyEDA auto-name', () => {
    const index = buildConnectionIndex(page({
        wires: [wire('w1', '$1N7', [0, 0, 0, 20])],
    }));
    const result = plan({ index, site: { x: 0, y: 0, rotation: 90 }, style: { symbol: 'flag' }, signalName: '$1N7' });
    assert.equal(result.ok === false && result.refusal.reason, 'NO_NET_NAME');
});

test('plan: style "wire" is refused with WOULD_ORPHAN unless the cluster reaches another pin', () => {
    const stubOnly = buildConnectionIndex(page({
        wires: [wire('w1', '', [0, 0, 0, 20])],
        pointSymbols: [flag('f1', 'N', 0, 20)],
    }));
    const refused = plan({ index: stubOnly, site: { x: 0, y: 0, rotation: 90 }, style: { symbol: 'wire' } });
    assert.equal(refused.ok === false && refused.refusal.reason, 'WOULD_ORPHAN');

    const pinToPin = buildConnectionIndex(page({
        wires: [wire('w1', '', [0, 0, 0, 20]), wire('w2', '', [0, 20, 40, 20])],
        pointSymbols: [flag('f1', 'N', 0, 20)],
    }));
    const allowed = plan({ index: pinToPin, site: { x: 0, y: 0, rotation: 90 }, style: { symbol: 'wire' }, pinKeys: ['40,20'] });
    assert.equal(allowed.ok, true);
    if (!allowed.ok) return;
    assert.equal(allowed.plan.create, null);
    assert.deepEqual(allowed.plan.remove.map(s => s.primitive_id), ['f1']);
});

test('plan: symbol sitting directly on the pin gets a stub and the new symbol at its end', () => {
    const index = buildConnectionIndex(page({
        pointSymbols: [flag('f1', 'GND', 0, 0)],
    }));
    const result = plan({ index, site: { x: 0, y: 0, rotation: 270 }, style: { symbol: 'port' } });
    assert.equal(result.ok, true);
    if (!result.ok) return;
    assert.deepEqual(result.plan.stub, [0, 0, 0, -10]);
    assert.equal(result.plan.create?.x, 0);
    assert.equal(result.plan.create?.y, -10);
    assert.deepEqual(result.plan.remove.map(s => s.primitive_id), ['f1']);
});

test('plan: pin-to-pin wire has no free end → NO_FREE_END for a flag, mid-segment for a label', () => {
    // Unnamed pin-to-pin wire; the netlist still knows the net as N through another symbol elsewhere.
    const index = buildConnectionIndex(page({
        wires: [wire('w1', '', [0, 0, 40, 0])],
    }));
    const pinKeys = ['40,0'];
    const flagResult = plan({ index, site: { x: 0, y: 0, rotation: 0 }, style: { symbol: 'flag' }, signalName: 'N', pinKeys });
    assert.equal(flagResult.ok === false && flagResult.refusal.reason, 'NO_FREE_END');

    const labelResult = plan({ index, site: { x: 0, y: 0, rotation: 0 }, style: { symbol: 'label' }, signalName: 'N', pinKeys });
    assert.equal(labelResult.ok, true);
    if (!labelResult.ok) return;
    assert.equal(labelResult.plan.create?.type, 'label');
    assert.equal(labelResult.plan.create?.x, 20);
    assert.equal(labelResult.plan.create?.y, 0);
    assert.equal(labelResult.plan.create?.wireId, 'w1');
});

test('verify: same members and same name passes; a rename fails unless style is wire', () => {
    const before = pinNetView({ components: [
        { designator: 'R1', pins: [{ pin_number: 1, signal_name: 'N' }, { pin_number: 2, signal_name: 'GND' }] },
        { designator: 'R2', pins: [{ pin_number: 1, signal_name: 'N' }] },
    ] });
    assert.deepEqual(netMembers(before, 'N'), ['R1.1', 'R2.1']);

    assert.deepEqual(verifyRestyleOutcome({ before, after: before, pinRef: 'R1.1', style: 'port' }), { ok: true });

    const renamed = pinNetView({ components: [
        { designator: 'R1', pins: [{ pin_number: 1, signal_name: '$1N3' }, { pin_number: 2, signal_name: 'GND' }] },
        { designator: 'R2', pins: [{ pin_number: 1, signal_name: '$1N3' }] },
    ] });
    assert.equal(verifyRestyleOutcome({ before, after: renamed, pinRef: 'R1.1', style: 'port' }).ok, false);
    assert.deepEqual(verifyRestyleOutcome({ before, after: renamed, pinRef: 'R1.1', style: 'wire' }), { ok: true });

    const split = pinNetView({ components: [
        { designator: 'R1', pins: [{ pin_number: 1, signal_name: 'N' }, { pin_number: 2, signal_name: 'GND' }] },
        { designator: 'R2', pins: [{ pin_number: 1, signal_name: 'N_2' }] },
    ] });
    const verdict = verifyRestyleOutcome({ before, after: split, pinRef: 'R1.1', style: 'flag' });
    assert.equal(verdict.ok, false);
    assert.match(!verdict.ok ? verdict.detail : '', /members changed/);
});

import { connectionStylesToRestyleItems } from '../src/eda/connections-core.ts';

test('connectionStylesToRestyleItems flattens the designator/pin map and ignores junk', () => {
    const items = connectionStylesToRestyleItems({
        R1: { '1': { symbol: 'label' }, '2': { symbol: 'port', direction: 'input' } },
        U8: { '4': { symbol: 'flag', flag_kind: 'Ground' } },
        // @ts-expect-error runtime data from the bridge may be malformed
        J1: { '1': { nope: true } },
    });
    assert.deepEqual(items, [
        { designator: 'R1', pin_number: '1', style: { symbol: 'label' } },
        { designator: 'R1', pin_number: '2', style: { symbol: 'port', direction: 'input' } },
        { designator: 'U8', pin_number: '4', style: { symbol: 'flag', flag_kind: 'Ground' } },
    ]);
    assert.deepEqual(connectionStylesToRestyleItems(undefined), []);
});


// ---------------------------------------------------------------------------
// Runtime facts from the scratch page (2026-09-09)
// ---------------------------------------------------------------------------

import { isAutoNetName, portDirectionFromPinName, wireNetLabel } from '../src/eda/connections-core.ts';

test('a wire with its own net name is a label; auto-names and blanks are not', () => {
    assert.deepEqual(wireNetLabel(wire('w1', 'SIG_A', [0, 0, 1, 0])), { id: 'w1', name: 'SIG_A', wireId: 'w1', source: 'wire_net' });
    assert.equal(wireNetLabel(wire('w2', '', [0, 0, 1, 0])), undefined);
    assert.equal(wireNetLabel(wire('w3', '$1N7', [0, 0, 1, 0])), undefined);
    assert.equal(isAutoNetName('$1N7'), true);
    assert.equal(isAutoNetName('GND'), false);
});

test('port direction comes from the native port pin name', () => {
    assert.equal(portDirectionFromPinName('IN'), 'input');
    assert.equal(portDirectionFromPinName('OUT'), 'output');
    assert.equal(portDirectionFromPinName('BI'), 'bidirectional');
    assert.equal(portDirectionFromPinName('Pin1'), null);
    assert.equal(portDirectionFromPinName(undefined), null);
});

test('scratch page R1.2: GND flag on the pin with a zero-length wire is reported and restyled via a stub', () => {
    // Exactly what EasyEDA produced when the flag was dropped on the pin.
    const index = buildConnectionIndex(page({
        wires: [wire('72df', '', [620, 515, 620, 515])],
        pointSymbols: [flag('bf41', 'GND', 620, 515)],
    }));
    const connection = describeConnectionAt(index, 620, 515);
    assert.equal(connection.wire_id, '72df');
    assert.deepEqual(names(connection.symbols), ['flag:GND']);

    const result = plan({ index, site: { x: 620, y: 515, rotation: 0 }, style: { symbol: 'port' }, signalName: 'GND' });
    assert.equal(result.ok, true);
    if (!result.ok) return;
    assert.deepEqual(result.plan.stub, [620, 515, 630, 515]);
    assert.deepEqual(result.plan.remove.map(s => s.primitive_id), ['bf41']);
});

test('scratch page R2.2: wire label DUP plus port DUP → restyle to label keeps the wire net and removes the port', () => {
    const index = buildConnectionIndex(page({
        wires: [wire('32e5', 'DUP', [620, 480, 635, 480])],
        pointSymbols: [port('3048', 'DUP', 635, 480, 'output')],
    }));
    const connection = describeConnectionAt(index, 620, 480);
    assert.deepEqual(names(connection.symbols).sort(), ['label:DUP', 'port:DUP']);

    const result = plan({ index, site: { x: 620, y: 480, rotation: 0 }, style: { symbol: 'label' }, signalName: 'DUP', pinKeys: ['620,480'] });
    assert.equal(result.ok, true);
    if (!result.ok) return;
    assert.equal(result.plan.keep?.primitive_id, '32e5');
    assert.deepEqual(result.plan.remove.map(s => s.primitive_id), ['3048']);
});


import { scopeChangeOf } from '../src/eda/connections-core.ts';

test('scope change: label ⇄ port/flag is reported, like-for-like and wire-from-label are not', () => {
    const lbl = { type: 'label' as const, name: 'N', direction: null, primitive_id: 'w1' };
    const prt = { type: 'port' as const, name: 'N', direction: 'output' as const, primitive_id: 'p1' };
    const flg = { type: 'flag' as const, name: 'N', direction: null, primitive_id: 'f1' };
    assert.equal(scopeChangeOf([lbl], { symbol: 'port', direction: 'input' }), 'local→global');
    assert.equal(scopeChangeOf([lbl], { symbol: 'flag' }), 'local→global');
    assert.equal(scopeChangeOf([prt], { symbol: 'label' }), 'global→local');
    assert.equal(scopeChangeOf([flg], { symbol: 'wire' }), 'global→local');
    assert.equal(scopeChangeOf([prt], { symbol: 'flag' }), null);
    assert.equal(scopeChangeOf([lbl, prt], { symbol: 'label' }), 'global→local');
    assert.equal(scopeChangeOf([lbl, prt], { symbol: 'port', direction: 'output' }), null);
    assert.equal(scopeChangeOf([lbl], { symbol: 'wire' }), null);
    assert.equal(scopeChangeOf([], { symbol: 'flag' }), 'local→global');
});

test('plan carries scope_change', () => {
    const index = buildConnectionIndex(page({ wires: [wire('w1', 'SIG_A', [0, 0, 0, 20])] }));
    const result = plan({ index, site: { x: 0, y: 0, rotation: 90 }, style: { symbol: 'port', direction: 'output' } });
    assert.equal(result.ok && result.plan.scope_change, 'local→global');
});


test('a flag is re-created natively when the wire name must be cleared (real-sheet case)', () => {
    // TVS1.1 on CruiserCtrl sheet 01: wire named VBAT_RAW plus assembly-placed port and flag.
    const index = buildConnectionIndex(page({
        wires: [wire('w1', 'VBAT_RAW', [100, 100, 100, 130])],
        pointSymbols: [flag('f1', 'VBAT_RAW', 100, 130), port('p1', 'VBAT_RAW', 100, 130, 'input')],
    }));
    const result = plan({ index, site: { x: 100, y: 100, rotation: 90 }, style: { symbol: 'flag', flag_kind: 'Power' }, signalName: 'VBAT_RAW' });
    assert.equal(result.ok, true);
    if (!result.ok) return;
    // The existing flag is NOT kept: it would stop naming the net once the wire name goes.
    assert.equal(result.plan.keep, null);
    assert.equal(result.plan.create?.type, 'flag');
    assert.equal(result.plan.create?.flagKind, 'Power');
    assert.deepEqual(result.plan.remove.map(s => s.type).sort(), ['flag', 'label', 'port']);
});

test('an existing symbol is still kept when no wire name has to be cleared', () => {
    const index = buildConnectionIndex(page({
        wires: [wire('w1', '', [100, 100, 100, 130])],
        pointSymbols: [flag('f1', 'GND', 100, 130), port('p1', 'GND', 100, 130, 'input')],
    }));
    const result = plan({ index, site: { x: 100, y: 100, rotation: 90 }, style: { symbol: 'flag' }, signalName: 'GND' });
    assert.equal(result.ok && result.plan.keep?.primitive_id, 'f1');
    assert.deepEqual(result.ok ? result.plan.remove.map(s => s.type) : [], ['port']);
});
