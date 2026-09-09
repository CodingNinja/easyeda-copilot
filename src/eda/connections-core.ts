/**
 * Pure core of per-pin connection styling. Works on plain data collected from
 * EasyEDA by `connections.ts`; never imports `eda`, so it is unit-testable.
 *
 * Vocabulary
 *  - A *wire cluster* is the set of wire primitives joined end to end (or by a
 *    T-junction) that a pin touches. EasyEDA stores one logical wire as several
 *    primitives, so the naming symbols of a pin live anywhere on the cluster.
 *  - A *point symbol* is a naming symbol anchored at a coordinate: NET_FLAG and
 *    NET_PORT components (and `netlabel` components, if EasyEDA reports them).
 *  - A *wire label* is a net label stored as an attribute whose parent is a wire.
 */

import { pointKey, pointOnSegment, to2 } from './geometry';

export type SymbolDirection = 'input' | 'output' | 'bidirectional';
export type SymbolType = 'flag' | 'port' | 'label';

export type ConnectionSymbol = {
    type: SymbolType;
    name: string;
    direction: SymbolDirection | null;
    primitive_id: string;
};

export type PinConnection = {
    wire_id: string | null;
    wire_net: string | null;
    symbols: ConnectionSymbol[];
};

export type WireData = {
    id: string;
    net: string;
    /** Already normalized: `[[x1, y1, x2, y2], ...]`. */
    segments: number[][];
};

export type PointSymbolData = {
    id: string;
    type: SymbolType;
    name: string;
    x: number;
    y: number;
    /** Kept so a removed symbol can be re-created on rollback. */
    rotation?: number;
    direction?: SymbolDirection | null;
};

/**
 * A net label. Runtime finding (2026-09-09): EasyEDA Pro stores a label typed with
 * **N** as the wire's own `net` attribute, not as a separate primitive. So a label's
 * `id` is the id of the wire that carries it, and `source` is `'wire_net'`.
 * `'attribute'` is kept for labels EasyEDA may report as attribute primitives.
 */
export type WireLabelData = {
    id: string;
    name: string;
    wireId: string;
    source?: 'wire_net' | 'attribute';
    /** Label anchor, when EasyEDA reports it; used to re-create the label on rollback. */
    x?: number | null;
    y?: number | null;
};

export type ConnectionsPageData = {
    wires: WireData[];
    pointSymbols: PointSymbolData[];
    wireLabels: WireLabelData[];
};

export type ConnectionIndex = {
    wireById: Map<string, WireData>;
    /** Segment endpoint key → ids of wires having an endpoint there. */
    wireIdsAtPoint: Map<string, string[]>;
    symbolsAtPoint: Map<string, PointSymbolData[]>;
    labelsByWire: Map<string, WireLabelData[]>;
    pointSymbols: PointSymbolData[];
};

export type WireCluster = {
    wireIds: string[];
    endpointKeys: string[];
};

export type Logger = (message: string) => void;

function push<K, V>(map: Map<K, V[]>, key: K, value: V) {
    const list = map.get(key);
    if (list) list.push(value);
    else map.set(key, [value]);
}

export function segmentEndpointKeys(segments: number[][]): string[] {
    const keys: string[] = [];
    for (const seg of segments) {
        if (seg.length < 4) continue;
        keys.push(pointKey(seg[0], seg[1]), pointKey(seg[2], seg[3]));
    }
    return keys;
}

/** True for names EasyEDA assigns itself to unnamed wires (`$1N7`, …). */
export function isAutoNetName(net: string | null | undefined): boolean {
    return !!net && net.trim().startsWith('$');
}

/** The label a wire carries through its own `net` attribute, if any. */
export function wireNetLabel(wire: WireData): WireLabelData | undefined {
    const net = wire.net?.trim();
    if (!net || isAutoNetName(net)) return undefined;
    return { id: wire.id, name: net, wireId: wire.id, source: 'wire_net' };
}

/** Direction of a native net port, read from the name of its single pin. */
export function portDirectionFromPinName(pinName: string | undefined | null): SymbolDirection | null {
    switch ((pinName ?? '').trim().toUpperCase()) {
        case 'IN': return 'input';
        case 'OUT': return 'output';
        case 'BI': return 'bidirectional';
        default: return null;
    }
}

export function buildConnectionIndex(data: ConnectionsPageData): ConnectionIndex {
    const wireById = new Map<string, WireData>();
    const wireIdsAtPoint = new Map<string, string[]>();
    const symbolsAtPoint = new Map<string, PointSymbolData[]>();
    const labelsByWire = new Map<string, WireLabelData[]>();

    for (const wire of data.wires) {
        wireById.set(wire.id, wire);
        for (const key of new Set(segmentEndpointKeys(wire.segments))) {
            push(wireIdsAtPoint, key, wire.id);
        }
        const label = wireNetLabel(wire);
        if (label) push(labelsByWire, wire.id, label);
    }

    for (const symbol of data.pointSymbols) {
        push(symbolsAtPoint, pointKey(symbol.x, symbol.y), symbol);
    }

    for (const label of data.wireLabels) {
        push(labelsByWire, label.wireId, label);
    }

    return { wireById, wireIdsAtPoint, symbolsAtPoint, labelsByWire, pointSymbols: data.pointSymbols };
}

/**
 * Wires touching a point. Wires with an endpoint exactly there come first;
 * wires whose segment interior passes through the point follow.
 */
export function findWiresAtPoint(index: ConnectionIndex, x: number, y: number): string[] {
    const found: string[] = [...(index.wireIdsAtPoint.get(pointKey(x, y)) ?? [])];
    const seen = new Set(found);
    const point = { x, y };

    for (const wire of index.wireById.values()) {
        if (seen.has(wire.id)) continue;
        if (wire.segments.some(seg => pointOnSegment(point, seg))) {
            found.push(wire.id);
            seen.add(wire.id);
        }
    }

    return found;
}

/** Breadth-first walk over wires joined end to end or by T-junction. */
export function collectWireCluster(index: ConnectionIndex, startWireId: string): WireCluster {
    const wireIds: string[] = [];
    const visited = new Set<string>();
    const endpointKeys = new Set<string>();
    const queue = [startWireId];

    while (queue.length) {
        const wireId = queue.shift()!;
        if (visited.has(wireId)) continue;
        const wire = index.wireById.get(wireId);
        if (!wire) continue;

        visited.add(wireId);
        wireIds.push(wireId);

        // Outward: wires that touch one of this wire's endpoints (end to end, or
        // this wire ending on the interior of another one).
        for (const seg of wire.segments) {
            if (seg.length < 4) continue;
            for (const [px, py] of [[seg[0], seg[1]], [seg[2], seg[3]]]) {
                endpointKeys.add(pointKey(px, py));
                for (const neighbour of findWiresAtPoint(index, px, py)) {
                    if (!visited.has(neighbour)) queue.push(neighbour);
                }
            }
        }

        // Inward: wires that end on the interior of one of this wire's segments
        // (a T-junction where EasyEDA did not split this wire).
        for (const other of index.wireById.values()) {
            if (visited.has(other.id)) continue;
            const endsOnThisWire = other.segments.some(seg => seg.length >= 4 && (
                wire.segments.some(mine => pointOnSegment({ x: seg[0], y: seg[1] }, mine))
                || wire.segments.some(mine => pointOnSegment({ x: seg[2], y: seg[3] }, mine))
            ));
            if (endsOnThisWire) queue.push(other.id);
        }
    }

    return { wireIds, endpointKeys: [...endpointKeys] };
}

function toConnectionSymbol(symbol: PointSymbolData | WireLabelData, type: SymbolType): ConnectionSymbol {
    return {
        type,
        name: symbol.name,
        direction: 'direction' in symbol ? symbol.direction ?? null : null,
        primitive_id: symbol.id,
    };
}

/** Every naming symbol on a wire cluster, de-duplicated by primitive id. Order is stable. */
export function symbolsOnCluster(index: ConnectionIndex, cluster: WireCluster): ConnectionSymbol[] {
    const result: ConnectionSymbol[] = [];
    const seen = new Set<string>();
    const add = (symbol: ConnectionSymbol) => {
        if (seen.has(symbol.primitive_id)) return;
        seen.add(symbol.primitive_id);
        result.push(symbol);
    };

    for (const wireId of cluster.wireIds) {
        for (const label of index.labelsByWire.get(wireId) ?? []) add(toConnectionSymbol(label, 'label'));
    }

    for (const key of cluster.endpointKeys) {
        for (const symbol of index.symbolsAtPoint.get(key) ?? []) add(toConnectionSymbol(symbol, symbol.type));
    }

    // Symbols dropped onto the interior of a segment (EasyEDA makes a junction there).
    const segments = cluster.wireIds.flatMap(id => index.wireById.get(id)?.segments ?? []);
    for (const symbol of index.pointSymbols) {
        if (seen.has(symbol.id)) continue;
        if (segments.some(seg => pointOnSegment(symbol, seg))) add(toConnectionSymbol(symbol, symbol.type));
    }

    return result;
}

/**
 * Describe what a pin at (x, y) is connected to: the wire touching it, that
 * wire's own net attribute, and every naming symbol on the wire cluster.
 * A symbol sitting directly on the pin with no wire is still reported.
 */
export function describeConnectionAt(index: ConnectionIndex, x: number, y: number, log?: Logger): PinConnection {
    const wireIds = findWiresAtPoint(index, x, y);

    if (!wireIds.length) {
        const direct = index.symbolsAtPoint.get(pointKey(x, y)) ?? [];
        return {
            wire_id: null,
            wire_net: null,
            symbols: direct.map(symbol => toConnectionSymbol(symbol, symbol.type)),
        };
    }

    if (wireIds.length > 1) {
        log?.(`Pin at ${to2(x)},${to2(y)} touches ${wireIds.length} wires; using ${wireIds[0]}`);
    }

    const wire = index.wireById.get(wireIds[0])!;
    const cluster = collectWireCluster(index, wire.id);

    return {
        wire_id: wire.id,
        wire_net: wire.net?.trim() ? wire.net : null,
        symbols: symbolsOnCluster(index, cluster),
    };
}

// ---------------------------------------------------------------------------
// Planning a restyle (deliverable 3: restyle_connections)
// ---------------------------------------------------------------------------

export type FlagKind = 'Power' | 'Ground' | 'AnalogGround' | 'ProtectGround';
export type StyleSymbol = SymbolType | 'wire';
export type ConnectionStyle = { symbol: StyleSymbol; direction?: SymbolDirection; flag_kind?: FlagKind };
export type RestyleItem = { designator: string; pin_number: string | number; style: ConnectionStyle };

/** Pin connection point and pin rotation as EasyEDA reports them. */
export type PinSite = { x: number; y: number; rotation: number };
export type Direction = { dx: number; dy: number };
/** `normWireY` from utils.ts: flips Y on EasyEDA API v2. Injected so this module stays eda-free. */
export type NormY = (y: number) => number;

export type PlannedSymbol = {
    type: SymbolType;
    name: string;
    x: number;
    y: number;
    rotation: number;
    flagKind?: FlagKind;
    direction: SymbolDirection | null;
    /** Labels only: the wire whose `net` attribute will carry the name. Null when the wire is the new stub. */
    wireId?: string | null;
};

/**
 * How far a naming symbol reaches. A label joins same-named wires on the same page
 * only; ports and flags join nets across pages of the project. Changing between the
 * two is legitimate but worth checking on a multi-sheet design, so it is reported
 * per item and never blocks a bulk edit.
 */
export type SymbolScope = 'local' | 'global';
export type ScopeChange = 'local→global' | 'global→local';

export function symbolScope(type: SymbolType): SymbolScope {
    return type === 'label' ? 'local' : 'global';
}

export function scopeChangeOf(existing: ConnectionSymbol[], style: ConnectionStyle): ScopeChange | null {
    const hadGlobal = existing.some(symbol => symbolScope(symbol.type) === 'global');
    const willBeGlobal = style.symbol !== 'wire' && symbolScope(style.symbol) === 'global';
    if (!hadGlobal && willBeGlobal) return 'local→global';
    if (hadGlobal && !willBeGlobal) return 'global→local';
    return null;
}

export type RestylePlan = {
    net: string;
    /** Set when the edit changes how far the net name reaches (see SymbolScope). */
    scope_change: ScopeChange | null;
    /** New stub wire `[x1, y1, x2, y2]`; only when the pin has no wire but a symbol sits directly on it. */
    stub: number[] | null;
    create: PlannedSymbol | null;
    remove: ConnectionSymbol[];
    /** An existing symbol that already matches the request and is left alone. */
    keep: ConnectionSymbol | null;
};

export type RestyleRefusalReason = 'NAME_MISMATCH' | 'WOULD_ORPHAN' | 'PIN_UNCONNECTED' | 'NO_NET_NAME' | 'NO_FREE_END';
export type RestyleRefusal = { reason: RestyleRefusalReason; detail: string };
export type RestylePlanResult = { ok: true; plan: RestylePlan } | { ok: false; refusal: RestyleRefusal };

export type RestylePlanInput = {
    item: RestyleItem;
    connection: PinConnection;
    /** The pin's net as the netlist reports it (`signal_name`); '' if unknown. */
    signalName: string;
    site: PinSite;
    index: ConnectionIndex;
    /** Point keys of every part pin on the page, including the pin being restyled. */
    pinKeys: Set<string>;
    normY: NormY;
};

export const STUB_LENGTH = 10;

/** Owner decision (2026-09-09): PGND → ProtectGround, other *GND* → Ground, everything else → Power. */
export function defaultFlagKind(net: string): FlagKind {
    const upper = net.toUpperCase();
    if (upper.includes('PGND')) return 'ProtectGround';
    if (upper.includes('GND')) return 'Ground';
    return 'Power';
}

export function distinctNames(symbols: ConnectionSymbol[]): string[] {
    return [...new Set(symbols.map(s => s.name))];
}

/** Outward direction of a pin from its rotation. Same thresholds as `place-net.ts`. */
export function outwardDirection(rotation: number, normY: NormY): Direction {
    const rot = ((rotation % 360) + 360) % 360;
    if (rot >= 270) return { dx: 0, dy: normY(-1) };
    if (rot >= 180) return { dx: -1, dy: 0 };
    if (rot >= 90) return { dx: 0, dy: normY(1) };
    return { dx: 1, dy: 0 };
}

export function stubLine(site: PinSite, normY: NormY, length = STUB_LENGTH): number[] {
    const dir = outwardDirection(site.rotation, normY);
    return [to2(site.x), to2(site.y), to2(site.x + dir.dx * length), to2(site.y + dir.dy * length)];
}

/**
 * Screen angle of a unit direction: +x → 0, +y (as normY reports it) → 90, −x → 180, −y → 270.
 */
export function directionAngle(dir: Direction, normY: NormY): number {
    if (dir.dx > 0) return 0;
    if (dir.dx < 0) return 180;
    return dir.dy === normY(1) ? 90 : 270;
}

/**
 * Angle a native symbol's pin points at when the symbol has rotation 0.
 * Measured on the scratch page (2026-09-09): a Netport (In) placed by hand at the
 * left end of a wire had rotation 0 and pin rotation 0 (pin points +x, into the
 * wire); a Netport (Out) at the right end had rotation 0 and pin rotation 180; a
 * Netport (Bi) created with rotation 90 reported pin rotation 270, so Bi behaves
 * like Out. Flags: a Power flag at rotation 0 stands above the wire end (pin points
 * down, 270); ground flags hang below it (pin points up, 90). [VERIFY H] vertical
 * cases still to be confirmed visually.
 */
export function basePinAngle(type: SymbolType, flagKind: FlagKind | undefined, direction: SymbolDirection | null): number {
    if (type === 'port') return direction === 'input' ? 0 : 180;
    if (type === 'flag') return flagKind === 'Power' ? 270 : 90;
    return 0;
}

/**
 * Rotation for a symbol placed at the end of a wire arriving along `dir` (dir points
 * from the wire toward the symbol). The symbol's pin must point back at the wire,
 * so rotation = (angle of −dir) − (pin angle at rotation 0).
 */
export function symbolRotation(dir: Direction, type: SymbolType, flagKind: FlagKind | undefined, normY: NormY, direction: SymbolDirection | null = null): number {
    if (type === 'label') return 0;
    const wanted = (directionAngle(dir, normY) + 180) % 360;
    return (((wanted - basePinAngle(type, flagKind, direction)) % 360) + 360) % 360;
}

export type FreeEnd = { x: number; y: number; dir: Direction; key: string };

function unitDirection(fromX: number, fromY: number, toX: number, toY: number): Direction {
    return { dx: Math.sign(to2(toX) - to2(fromX)), dy: Math.sign(to2(toY) - to2(fromY)) };
}

/**
 * Cluster endpoints that are not a pin and where no other wire continues:
 * the places a naming symbol can be attached without changing the wiring.
 */
export function freeEndsOfCluster(index: ConnectionIndex, cluster: WireCluster, pinKeys: Set<string>): FreeEnd[] {
    const result: FreeEnd[] = [];
    const seen = new Set<string>();

    for (const wireId of cluster.wireIds) {
        const wire = index.wireById.get(wireId);
        if (!wire) continue;
        for (const seg of wire.segments) {
            if (seg.length < 4) continue;
            const ends: Array<[number, number, number, number]> = [
                [seg[2], seg[3], seg[0], seg[1]],
                [seg[0], seg[1], seg[2], seg[3]],
            ];
            for (const [fx, fy, x, y] of ends) {
                const key = pointKey(x, y);
                if (seen.has(key) || pinKeys.has(key)) continue;
                if (findWiresAtPoint(index, x, y).length !== 1) continue;
                seen.add(key);
                result.push({ x: to2(x), y: to2(y), dir: unitDirection(fx, fy, x, y), key });
            }
        }
    }

    return result;
}

function matchesRequestedStyle(symbol: ConnectionSymbol, style: ConnectionStyle): boolean {
    if (symbol.type !== style.symbol) return false;
    // A requested direction or flag kind can only be honoured by re-creating the
    // symbol, because neither is reliably readable back from EasyEDA.
    if (style.symbol === 'port') return !!style.direction && symbol.direction === style.direction;
    if (style.symbol === 'flag' && style.flag_kind) return false;
    return true;
}

function refuse(reason: RestyleRefusalReason, detail: string): RestylePlanResult {
    return { ok: false, refusal: { reason, detail } };
}

export function planRestyle(input: RestylePlanInput): RestylePlanResult {
    const { item, connection, signalName, site, index, pinKeys, normY } = input;
    const style = item.style;
    const symbols = connection.symbols;
    const pinRef = `${item.designator}.${item.pin_number}`;

    if (!connection.wire_id && !symbols.length) {
        return refuse('PIN_UNCONNECTED', `${pinRef} has no wire and no naming symbol; naming it is a wiring change, use external_connect.`);
    }

    const names = distinctNames(symbols);
    if (names.length > 1) {
        return refuse('NAME_MISMATCH', `${pinRef}: the wire carries ${names.length} different names (${names.join(', ')}); fix the merged net by hand first.`);
    }
    if (names.length === 1 && signalName && names[0] !== signalName) {
        return refuse('NAME_MISMATCH', `${pinRef}: symbol says "${names[0]}" but the netlist says "${signalName}".`);
    }

    const net = names[0] ?? (signalName || connection.wire_net || '');
    if (!net || net.startsWith('$')) {
        return refuse('NO_NET_NAME', `${pinRef}: the net has no human name (${net || 'empty'}); name it with external_connect first.`);
    }

    const cluster: WireCluster = connection.wire_id
        ? collectWireCluster(index, connection.wire_id)
        : { wireIds: [], endpointKeys: [] };
    const ownKey = pointKey(site.x, site.y);

    if (style.symbol === 'wire') {
        const reachesAnotherPin = cluster.endpointKeys.some(key => key !== ownKey && pinKeys.has(key));
        if (!reachesAnotherPin) {
            return refuse('WOULD_ORPHAN', `${pinRef}: without a naming symbol the wire would not reach any other pin on this page.`);
        }
        return { ok: true, plan: { net, scope_change: scopeChangeOf(symbols, style), stub: null, create: null, remove: symbols, keep: null } };
    }

    const keep = symbols.find(symbol => matchesRequestedStyle(symbol, style)) ?? null;
    const remove = symbols.filter(symbol => symbol !== keep);
    if (keep) {
        return { ok: true, plan: { net, scope_change: scopeChangeOf(symbols, style), stub: null, create: null, remove, keep } };
    }

    let stub: number[] | null = null;
    let x: number;
    let y: number;
    let dir: Direction;
    let labelWireId: string | null = connection.wire_id;

    // A symbol dropped straight onto a pin leaves either no wire or a zero-length wire
    // whose only endpoint is the pin itself. Either way there is nothing to attach to.
    const onPin = !connection.wire_id || cluster.endpointKeys.every(key => key === ownKey);

    if (onPin) {
        // Give the pin a proper stub and put the new symbol at its end.
        stub = stubLine(site, normY);
        x = stub[2];
        y = stub[3];
        dir = outwardDirection(site.rotation, normY);
        labelWireId = null;
    } else if (style.symbol === 'label') {
        // The label is the wire's own net attribute: it goes on the pin's wire, at the
        // middle of the segment touching the pin.
        const wire = index.wireById.get(connection.wire_id!)!;
        const seg = wire.segments.find(s => s.length >= 4 && pointOnSegment(site, s)) ?? wire.segments[0];
        x = to2((seg[0] + seg[2]) / 2);
        y = to2((seg[1] + seg[3]) / 2);
        dir = unitDirection(seg[0], seg[1], seg[2], seg[3]);
    } else {
        const ends = freeEndsOfCluster(index, cluster, pinKeys);
        const removeIds = new Set(remove.map(symbol => symbol.primitive_id));
        const vacated = ends.find(end => (index.symbolsAtPoint.get(end.key) ?? []).some(symbol => removeIds.has(symbol.id)));
        const end = vacated ?? ends[0];

        if (!end) {
            return refuse('NO_FREE_END', `${pinRef}: the wire runs pin to pin with no free end to hold a ${style.symbol}; use "label" instead.`);
        }
        x = end.x;
        y = end.y;
        dir = end.dir;
    }

    const flagKind = style.symbol === 'flag' ? style.flag_kind ?? defaultFlagKind(net) : undefined;
    const create: PlannedSymbol = {
        type: style.symbol,
        name: net,
        x,
        y,
        rotation: symbolRotation(dir, style.symbol, flagKind, normY, style.symbol === 'port' ? style.direction ?? 'bidirectional' : null),
        ...(flagKind ? { flagKind } : {}),
        direction: style.symbol === 'port' ? style.direction ?? 'bidirectional' : null,
        ...(style.symbol === 'label' ? { wireId: labelWireId } : {}),
    };

    return { ok: true, plan: { net, scope_change: scopeChangeOf(symbols, style), stub, create, remove, keep: null } };
}

// ---------------------------------------------------------------------------
// Verifying a restyle against netlist read-backs
// ---------------------------------------------------------------------------

export type SchematicLike = { components: Array<{ designator: string; pins: Array<{ pin_number: string | number; signal_name: string }> }> };
/** "designator.pin" → signal_name */
export type PinNetView = Map<string, string>;

export function pinNetView(schematic: SchematicLike): PinNetView {
    const view: PinNetView = new Map();
    for (const component of schematic.components) {
        for (const pin of component.pins) view.set(`${component.designator}.${pin.pin_number}`, pin.signal_name);
    }
    return view;
}

export function netMembers(view: PinNetView, net: string): string[] {
    if (!net) return [];
    return [...view].filter(([, signal]) => signal === net).map(([ref]) => ref).sort();
}

/**
 * A restyle succeeded when the pin still shares its net with exactly the same
 * pins as before. The net *name* must also survive unless the style is `wire`,
 * where removing the last symbol legitimately leaves an auto-named net.
 */
export function verifyRestyleOutcome(args: { before: PinNetView; after: PinNetView; pinRef: string; style: StyleSymbol }): { ok: true } | { ok: false; detail: string } {
    const { before, after, pinRef, style } = args;
    const beforeNet = before.get(pinRef) ?? '';
    const afterNet = after.get(pinRef) ?? '';

    if (style !== 'wire' && afterNet !== beforeNet) {
        return { ok: false, detail: `${pinRef} net changed from "${beforeNet}" to "${afterNet}"` };
    }
    if (!afterNet) {
        return { ok: false, detail: `${pinRef} lost its net (was "${beforeNet}")` };
    }

    const beforeMembers = netMembers(before, beforeNet).join(' ');
    const afterMembers = netMembers(after, afterNet).join(' ');
    if (beforeMembers !== afterMembers) {
        return { ok: false, detail: `${pinRef} net members changed: [${beforeMembers}] → [${afterMembers}]` };
    }
    return { ok: true };
}

// ---------------------------------------------------------------------------
// connection_style at placement (deliverable 2) → restyle items
// ---------------------------------------------------------------------------

/** designator → pin number → style, as sent by the MCP server alongside the assembly. */
export type ConnectionStylesMap = Record<string, Record<string, ConnectionStyle>>;

export function connectionStylesToRestyleItems(map: ConnectionStylesMap | undefined): RestyleItem[] {
    if (!map) return [];
    const items: RestyleItem[] = [];
    for (const [designator, pins] of Object.entries(map)) {
        for (const [pinNumber, style] of Object.entries(pins ?? {})) {
            if (style && typeof style.symbol === 'string') items.push({ designator, pin_number: pinNumber, style });
        }
    }
    return items;
}
