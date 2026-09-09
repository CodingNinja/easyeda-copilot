/**
 * Per-pin connection styling: reading which naming symbol (power flag, net port,
 * net label) sits on the wire that touches a pin, and changing that symbol
 * without changing the net.
 *
 * Everything that talks to `eda` lives at the top of the exported entry points.
 * Geometry and planning are pure functions over plain data so they can be unit
 * tested from `tests/connections.test.ts` without EasyEDA.
 */

import type { ExplainCircuit } from '@copilot/shared/types/circuit';
import {
    buildConnectionIndex,
    defaultFlagKind,
    describeConnectionAt,
    isAutoNetName,
    pinNetView,
    planRestyle,
    portDirectionFromPinName,
    verifyRestyleOutcome,
    type ConnectionIndex,
    type ConnectionsPageData,
    type ConnectionSymbol,
    type PinNetView,
    type PinSite,
    type PlannedSymbol,
    type PointSymbolData,
    type RestyleItem,
    type RestylePlan,
    type RestyleRefusalReason,
    type ScopeChange,
    type SymbolDirection,
    type SymbolType,
    type WireData,
    type WireLabelData,
} from './connections-core';
import { getSchematic } from './schematic';
import { searchComponentInSCH } from './search';
import { normalizeWireLine, normWireY, to2 } from './utils';
import { sch_PrimitiveWireSnap } from './wire-snap';

type AnyComponent = ISCH_PrimitiveComponent | ISCH_PrimitiveComponent$1;

const log = (message: string, type: ESYS_LogType = ESYS_LogType.INFO) => {
    eda.sys_Log.add(`[connections] ${message}`, type);
};

function safe<T>(read: () => T, fallback: T): T {
    try {
        return read();
    } catch {
        return fallback;
    }
}

// ---------------------------------------------------------------------------
// Collecting page data from EasyEDA (deliverable 1: include_connections)
// ---------------------------------------------------------------------------

/** Which naming-symbol kind a component primitive is, or undefined for ordinary parts. */
export function symbolTypeOfComponentType(componentType: string): SymbolType | undefined {
    switch (componentType) {
        case ESCH_PrimitiveComponentType.NET_FLAG: return 'flag';
        case ESCH_PrimitiveComponentType.NET_PORT: return 'port';
        case ESCH_PrimitiveComponentType.NET_LABEL: return 'label';
        default: return undefined;
    }
}

/** Net name carried by a flag/port: same expression `getSchematic()` uses. */
function symbolNetName(component: AnyComponent): string | undefined {
    const net = safe(() => component.getState_Net(), undefined)
        || safe(() => component.getState_OtherProperty()?.['Global Net Name'], undefined);
    return typeof net === 'string' && net.trim() ? net : undefined;
}

/**
 * Connection point of a one-pin symbol and, for ports, its direction. Runtime finding
 * (2026-09-09): the typings expose no direction getter, but a native port's single
 * pin is named `IN` / `OUT` / `BI`. Falls back to the component origin when the pin
 * cannot be read, as `getShortSymPos()` does.
 */
async function symbolAnchor(id: string, component: AnyComponent): Promise<{ x: number; y: number; direction: SymbolDirection | null }> {
    const pins = await eda.sch_PrimitiveComponent.getAllPinsByPrimitiveId(id).catch(() => undefined);
    if (Array.isArray(pins) && pins.length === 1) {
        return {
            x: pins[0].getState_X(),
            y: pins[0].getState_Y(),
            direction: portDirectionFromPinName(safe(() => pins[0].getState_PinName(), '')),
        };
    }
    return { x: component.getState_X(), y: component.getState_Y(), direction: null };
}

export async function collectPageConnections(): Promise<ConnectionsPageData> {
    const warn = (what: string) => (error: unknown) => {
        log(`${what} failed: ${(error as Error)?.message ?? error}`, ESYS_LogType.WARNING);
        return [] as never[];
    };

    const components = await eda.sch_PrimitiveComponent.getAll().catch(warn('sch_PrimitiveComponent.getAll'));
    const rawWires = await eda.sch_PrimitiveWire.getAll().catch(warn('sch_PrimitiveWire.getAll'));
    const attributes = await eda.sch_PrimitiveAttribute.getAll().catch(warn('sch_PrimitiveAttribute.getAll'));

    const wires: WireData[] = rawWires.map(wire => ({
        id: wire.getState_PrimitiveId(),
        net: safe(() => wire.getState_Net(), '') ?? '',
        segments: normalizeWireLine(safe<number[] | number[][]>(() => wire.getState_Line(), [])),
    }));
    const wireIds = new Set(wires.map(wire => wire.id));

    const pointSymbols: PointSymbolData[] = [];
    for (const component of components) {
        const type = symbolTypeOfComponentType(safe(() => String(component.getState_ComponentType()), ''));
        if (!type) continue;

        const id = component.getState_PrimitiveId();
        const name = symbolNetName(component);
        if (!name) {
            log(`${type} ${id} has no net name; ignored`, ESYS_LogType.WARNING);
            continue;
        }

        const anchor = await symbolAnchor(id, component);
        pointSymbols.push({
            id,
            type,
            name,
            x: anchor.x,
            y: anchor.y,
            rotation: safe(() => component.getState_Rotation(), 0),
            direction: type === 'port' ? anchor.direction : null,
        });
    }

    // Labels typed with N are the wire's own `net` attribute; buildConnectionIndex()
    // derives those. Attribute primitives parented to a wire are kept as a secondary
    // source in case some EasyEDA versions report labels that way (none seen so far).
    const wireLabels: WireLabelData[] = [];
    const seenKeys = new Set<string>();
    for (const attribute of attributes) {
        const parent = safe(() => attribute.getState_ParentPrimitiveId(), '');
        if (!parent || !wireIds.has(parent)) continue;

        const key = safe(() => attribute.getState_Key(), '');
        const value = safe(() => attribute.getState_Value(), '');
        if (!seenKeys.has(key)) {
            seenKeys.add(key);
            log(`wire attribute key "${key}" seen (treated as net label)`);
        }
        if (!value.trim()) continue;

        wireLabels.push({
            id: attribute.getState_PrimitiveId(),
            name: value,
            wireId: parent,
            source: 'attribute',
            x: safe(() => attribute.getState_X(), null),
            y: safe(() => attribute.getState_Y(), null),
        });
    }

    return { wires, pointSymbols, wireLabels };
}

type PinPosition = { pinNumber: string; x: number; y: number };

/** Pin connection points of every ordinary part on the page, grouped by designator. */
async function collectComponentPins(): Promise<Map<string, PinPosition[]>> {
    const components = await eda.sch_PrimitiveComponent.getAll().catch(() => [] as AnyComponent[]);
    const result = new Map<string, PinPosition[]>();

    for (const component of components) {
        if (safe(() => String(component.getState_ComponentType()), '') !== ESCH_PrimitiveComponentType.COMPONENT) continue;
        const designator = safe(() => component.getState_Designator() ?? '', '').trim();
        if (!designator) continue;

        const pins = await eda.sch_PrimitiveComponent.getAllPinsByPrimitiveId(component.getState_PrimitiveId()).catch(() => undefined);
        if (!Array.isArray(pins)) continue;

        const list = result.get(designator) ?? [];
        for (const pin of pins) {
            list.push({ pinNumber: String(pin.getState_PinNumber()), x: pin.getState_X(), y: pin.getState_Y() });
        }
        result.set(designator, list);
    }

    return result;
}

/**
 * Deliverable 1: attach `connection` to every pin of an already-read schematic.
 * Returns a new object; the input is not mutated.
 */
export async function annotateConnections(schematic: ExplainCircuit): Promise<ExplainCircuit> {
    const index = buildConnectionIndex(await collectPageConnections());
    const pinsByDesignator = await collectComponentPins();
    const warn = (message: string) => log(message, ESYS_LogType.WARNING);

    const components = schematic.components.map(component => {
        const positions = pinsByDesignator.get(component.designator);
        if (!positions) {
            warn(`no primitive found for ${component.designator}; connections not annotated`);
            return component;
        }

        const pins = component.pins.map(pin => {
            const position = positions.find(p => p.pinNumber === String(pin.pin_number));
            if (!position) {
                warn(`pin ${component.designator}.${pin.pin_number} not found on the page; connection not annotated`);
                return pin;
            }
            return { ...pin, connection: describeConnectionAt(index, position.x, position.y, warn) };
        });

        return { ...component, pins };
    });

    return { ...schematic, components };
}

// ---------------------------------------------------------------------------
// Diagnostic dump (Phase 0). Read-only. Exposed through the MCP tool
// `debug_dump_net_symbols`, which is registered only when EASYEDA_COPILOT_DEBUG=1.
// ---------------------------------------------------------------------------

export type NetSymbolDump = {
    components: Array<{
        id: string;
        type: string;
        primitiveType: string;
        designator: string;
        name: string | undefined;
        net: string | undefined;
        other: Record<string, unknown> | undefined;
        x: number;
        y: number;
        rot: number;
        mirror: boolean;
        /** Pins are listed only for non-part primitives (flags, ports, labels). */
        pins?: Array<{ id: string; number: string; name: string; x: number; y: number; rot: number }>;
        attributes?: NetSymbolDump['attributes'];
    }>;
    wires: Array<{ id: string; net: string; line: number[] | number[][]; attributes?: NetSymbolDump['attributes'] }>;
    attributes: Array<{
        id: string;
        parent: string;
        key: string;
        value: string;
        keyVisible: boolean | null;
        valueVisible: boolean | null;
        x: number | null;
        y: number | null;
    }>;
};

export async function dumpNetSymbols(): Promise<NetSymbolDump> {
    const warn = (what: string) => (error: unknown) => {
        eda.sys_Log.add(`[dumpNetSymbols] ${what} failed: ${(error as Error)?.message ?? error}`, ESYS_LogType.WARNING);
        return [] as never[];
    };

    const comps = await eda.sch_PrimitiveComponent.getAll().catch(warn('sch_PrimitiveComponent.getAll'));
    const wires = await eda.sch_PrimitiveWire.getAll().catch(warn('sch_PrimitiveWire.getAll'));
    const attrs = await eda.sch_PrimitiveAttribute.getAll().catch(warn('sch_PrimitiveAttribute.getAll'));

    const components: NetSymbolDump['components'] = [];
    for (const c of comps) {
        const id = c.getState_PrimitiveId();
        const type = safe(() => String(c.getState_ComponentType()), 'unknown');
        const entry: NetSymbolDump['components'][number] = {
            id,
            type,
            primitiveType: safe(() => String(c.getState_PrimitiveType()), 'unknown'),
            designator: safe(() => c.getState_Designator() ?? '', ''),
            name: safe(() => c.getState_Name(), undefined),
            net: safe(() => c.getState_Net(), undefined),
            other: safe(() => c.getState_OtherProperty(), undefined) as Record<string, unknown> | undefined,
            x: safe(() => c.getState_X(), NaN),
            y: safe(() => c.getState_Y(), NaN),
            rot: safe(() => c.getState_Rotation(), NaN),
            mirror: safe(() => c.getState_Mirror(), false),
        };

        if (type !== ESCH_PrimitiveComponentType.COMPONENT) {
            const pins = await eda.sch_PrimitiveComponent.getAllPinsByPrimitiveId(id).catch(() => undefined);
            if (Array.isArray(pins)) {
                entry.pins = pins.map(p => ({
                    id: safe(() => p.getState_PrimitiveId(), ''),
                    number: safe(() => p.getState_PinNumber(), ''),
                    name: safe(() => p.getState_PinName(), ''),
                    x: safe(() => p.getState_X(), NaN),
                    y: safe(() => p.getState_Y(), NaN),
                    rot: safe(() => p.getState_Rotation(), NaN),
                }));
            }
        }

        components.push(entry);
    }

    // sch_PrimitiveAttribute.getAll() without a parent returned nothing at runtime, so
    // also ask per wire and per symbol to see what EasyEDA reports for labels.
    const attributesOf = async (parentId: string) => {
        const list = await eda.sch_PrimitiveAttribute.getAll(parentId).catch(() => []);
        return list.map(a => ({
            id: a.getState_PrimitiveId(),
            parent: parentId,
            key: safe(() => a.getState_Key(), ''),
            value: safe(() => a.getState_Value(), ''),
            keyVisible: safe(() => a.getState_KeyVisible(), null),
            valueVisible: safe(() => a.getState_ValueVisible(), null),
            x: safe(() => a.getState_X(), null),
            y: safe(() => a.getState_Y(), null),
        }));
    };
    const wireDumps: NetSymbolDump['wires'] = [];
    for (const w of wires) {
        const id = w.getState_PrimitiveId();
        wireDumps.push({
            id,
            net: safe(() => w.getState_Net(), ''),
            line: safe<number[] | number[][]>(() => w.getState_Line(), []),
            attributes: await attributesOf(id),
        });
    }
    for (const entry of components) {
        if (entry.type !== ESCH_PrimitiveComponentType.COMPONENT) entry.attributes = await attributesOf(entry.id);
    }

    return {
        components,
        wires: wireDumps,
        attributes: attrs.map(a => ({
            id: a.getState_PrimitiveId(),
            parent: safe(() => a.getState_ParentPrimitiveId(), ''),
            key: safe(() => a.getState_Key(), ''),
            value: safe(() => a.getState_Value(), ''),
            keyVisible: safe(() => a.getState_KeyVisible(), null),
            valueVisible: safe(() => a.getState_ValueVisible(), null),
            x: safe(() => a.getState_X(), null),
            y: safe(() => a.getState_Y(), null),
        })),
    };
}

// ---------------------------------------------------------------------------
// Restyling (deliverable 3: restyle_connections; reused by deliverable 2)
// ---------------------------------------------------------------------------

export type RestyleAppliedEntry = {
    item: RestyleItem;
    plan: RestylePlan;
    dry_run?: true;
    noop?: true;
    created_id?: string | null;
    removed_ids?: string[];
    /** How labels were removed: attribute API, clearing the wire's net, or re-creating the wire ([VERIFY B]). */
    label_removal?: 'attribute_delete' | 'wire_net_cleared' | 'wire_recreated';
    /** How a label was created: the alpha createNetLabel() call, or by setting the wire's net attribute ([VERIFY E]). */
    label_creation?: 'createNetLabel' | 'wire_net_set';
};

export type RestyleReport = {
    applied: RestyleAppliedEntry[];
    skipped: Array<{ item: RestyleItem; reason: RestyleRefusalReason; detail: string }>;
    errors: Array<{ item: RestyleItem; error: string; code?: 'ROLLED_BACK' | 'ROLLBACK_FAILED' }>;
    /** "designator.pin" → net, for the requested pins, before and after the whole call. */
    before: Record<string, string>;
    after: Record<string, string>;
    /**
     * Applied items whose symbol scope changed (label ⇄ port/flag). Connectivity on this
     * page was verified; whether the net should now reach (or stop reaching) other pages
     * is a design question to review afterwards.
     */
    scope_changes: Array<{ pin: string; net: string; change: ScopeChange }>;
};

type LocatedPin = { primitiveId: string; site: PinSite };

async function locatePin(item: RestyleItem): Promise<LocatedPin | undefined> {
    const found = await searchComponentInSCH(item.designator);
    if (!found?.length) return undefined;

    for (const { primitiveId } of found) {
        const pins = await eda.sch_PrimitiveComponent.getAllPinsByPrimitiveId(primitiveId).catch(() => undefined);
        const pin = pins?.find(p => String(p.getState_PinNumber()) === String(item.pin_number));
        if (pin) {
            return {
                primitiveId,
                site: { x: pin.getState_X(), y: pin.getState_Y(), rotation: safe(() => pin.getState_Rotation(), 0) },
            };
        }
    }
    return undefined;
}

async function allPinKeys(): Promise<Set<string>> {
    const keys = new Set<string>();
    for (const pins of (await collectComponentPins()).values()) {
        for (const pin of pins) keys.add(`${to2(pin.x)},${to2(pin.y)}`);
    }
    return keys;
}

const PORT_DIRECTION = { input: 'IN', output: 'OUT', bidirectional: 'BI' } as const;

async function commit(primitive: unknown) {
    const done = (primitive as { done?: () => Promise<unknown> } | undefined)?.done;
    if (typeof done === 'function') await done.call(primitive).catch(() => undefined);
}

async function wireNet(wireId: string): Promise<string | undefined> {
    const wire = await eda.sch_PrimitiveWire.get(wireId).catch(() => undefined);
    return wire ? safe(() => wire.getState_Net(), '') ?? '' : undefined;
}

/**
 * Give a wire a net label. The label is the wire's `net` attribute, so the result id
 * is the wire id. Tries the dedicated (alpha) createNetLabel() first and confirms the
 * wire took the name; otherwise sets the net attribute directly.
 */
let lastLabelCreation: RestyleAppliedEntry['label_creation'];

async function createLabel(symbol: PlannedSymbol, wireId: string): Promise<string | undefined> {
    lastLabelCreation = undefined;
    const created = await eda.sch_PrimitiveAttribute
        .createNetLabel(symbol.x, symbol.y, symbol.name)
        .catch(error => {
            log(`createNetLabel failed: ${(error as Error).message}`, ESYS_LogType.WARNING);
            return undefined;
        });
    await commit(created);
    if (await wireNet(wireId) === symbol.name) {
        log(`label "${symbol.name}" set on ${wireId} via createNetLabel`);
        lastLabelCreation = 'createNetLabel';
        return wireId;
    }

    await sch_PrimitiveWireSnap.modify(wireId, { net: symbol.name }).catch(error => {
        log(`wire modify(net) failed: ${(error as Error).message}`, ESYS_LogType.WARNING);
        return undefined;
    });
    if (await wireNet(wireId) === symbol.name) {
        log(`label "${symbol.name}" set on ${wireId} via wire net attribute`);
        lastLabelCreation = 'wire_net_set';
        return wireId;
    }
    return undefined;
}

/** Create one naming symbol. Returns its primitive id, or undefined when EasyEDA refused. */
async function createSymbol(symbol: PlannedSymbol, labelWireId?: string): Promise<string | undefined> {
    if (symbol.type === 'label') {
        const wireId = labelWireId ?? symbol.wireId;
        if (!wireId) {
            log(`label "${symbol.name}" has no wire to attach to`, ESYS_LogType.WARNING);
            return undefined;
        }
        return createLabel(symbol, wireId);
    }

    let created: { getState_PrimitiveId(): string } | undefined;

    if (symbol.type === 'flag') {
        created = await eda.sch_PrimitiveComponent
            .createNetFlag(symbol.flagKind ?? 'Power', symbol.name, symbol.x, symbol.y, symbol.rotation)
            .catch(error => {
                log(`createNetFlag failed: ${(error as Error).message}`, ESYS_LogType.WARNING);
                return undefined;
            });
    } else if (symbol.type === 'port') {
        created = await eda.sch_PrimitiveComponent
            .createNetPort(PORT_DIRECTION[symbol.direction ?? 'bidirectional'], symbol.name, symbol.x, symbol.y, symbol.rotation)
            .catch(error => {
                log(`createNetPort failed: ${(error as Error).message}`, ESYS_LogType.WARNING);
                return undefined;
            });
    }

    if (!created) return undefined;
    await commit(created);
    return safe(() => created!.getState_PrimitiveId(), undefined as string | undefined);
}

async function attributeExists(id: string): Promise<boolean> {
    const attribute = await eda.sch_PrimitiveAttribute.get(id).catch(() => undefined);
    return !!attribute;
}

type RemovalVia = 'component_delete' | 'attribute_delete' | 'wire_net_cleared' | 'wire_recreated';
type RemovalOutcome = { ok: true; via: RemovalVia } | { ok: false; error: string };

/**
 * Remove one naming symbol. Flags and ports are components. A label is the wire's
 * `net` attribute: clear it, and if EasyEDA will not accept an empty net, delete
 * the wire and re-create it without a net (owner decision 2026-09-09). Labels that
 * came from attribute primitives are tried through the attribute API first, which
 * the typings document as a no-op ([VERIFY B]).
 */
async function removeSymbol(symbol: ConnectionSymbol, index: ConnectionIndex): Promise<RemovalOutcome> {
    if (symbol.type !== 'label') {
        const ok = await eda.sch_PrimitiveComponent.delete(symbol.primitive_id).catch(() => false);
        return ok ? { ok: true, via: 'component_delete' } : { ok: false, error: `delete(${symbol.primitive_id}) returned false` };
    }

    const label = [...index.labelsByWire.values()].flat().find(l => l.id === symbol.primitive_id);
    const wireId = label?.wireId ?? symbol.primitive_id;

    if (label?.source === 'attribute') {
        try {
            // Typings declare delete() without parameters; the runtime may accept an id.
            await (eda.sch_PrimitiveAttribute as unknown as { delete(id: string): unknown }).delete(symbol.primitive_id);
        } catch {
            // fall through
        }
        if (!await attributeExists(symbol.primitive_id)) return { ok: true, via: 'attribute_delete' };
    }

    const wire = await eda.sch_PrimitiveWire.get(wireId).catch(() => undefined);
    if (!wire) return { ok: false, error: `label ${symbol.primitive_id}: wire ${wireId} not found` };

    await sch_PrimitiveWireSnap.modify(wireId, { net: '' }).catch(() => undefined);
    if (!await wireNet(wireId)) return { ok: true, via: 'wire_net_cleared' };

    const line = wire.getState_Line();
    const deleted = await sch_PrimitiveWireSnap.delete(wireId).catch(() => false);
    if (!deleted) return { ok: false, error: `wire ${wireId} could not be deleted to drop label "${symbol.name}"` };

    const recreated = await sch_PrimitiveWireSnap.create(line).catch(() => undefined);
    if (!recreated) return { ok: false, error: `wire ${wireId} was deleted but could not be re-created (line ${JSON.stringify(line)})` };
    await commit(recreated);
    return { ok: true, via: 'wire_recreated' };
}

function symbolToPlanned(symbol: ConnectionSymbol, index: ConnectionIndex): PlannedSymbol | undefined {
    const point = index.pointSymbols.find(s => s.id === symbol.primitive_id);
    if (point) {
        return {
            type: point.type,
            name: point.name,
            x: point.x,
            y: point.y,
            rotation: point.rotation ?? 0,
            ...(point.type === 'flag' ? { flagKind: defaultFlagKind(point.name) } : {}),
            direction: point.direction ?? null,
        };
    }
    for (const labels of index.labelsByWire.values()) {
        const label = labels.find(l => l.id === symbol.primitive_id);
        if (!label) continue;
        const seg = index.wireById.get(label.wireId)?.segments[0] ?? [0, 0, 0, 0];
        return {
            type: 'label',
            name: label.name,
            x: label.x ?? to2((seg[0] + seg[2]) / 2),
            y: label.y ?? to2((seg[1] + seg[3]) / 2),
            rotation: 0,
            direction: null,
            wireId: label.wireId,
        };
    }
    return undefined;
}

async function readPinNets(): Promise<PinNetView> {
    const ids = await eda.sch_PrimitiveComponent.getAllPrimitiveId().catch(() => [] as string[]);
    return pinNetView(await getSchematic([...ids], { disableExtractPos: true }));
}

function pick(view: PinNetView, items: RestyleItem[]): Record<string, string> {
    const result: Record<string, string> = {};
    for (const item of items) {
        const ref = `${item.designator}.${item.pin_number}`;
        result[ref] = view.get(ref) ?? '';
    }
    return result;
}

/**
 * Apply `restyle_connections` items one at a time. Each item is planned from a
 * fresh page read, executed create-first / delete-second, verified against the
 * netlist, and rolled back on verification failure. With `dryRun` no mutating
 * `eda.*` call is made.
 */
export async function restyleConnections(items: RestyleItem[], options: { dryRun: boolean }): Promise<RestyleReport> {
    const { dryRun } = options;
    const report: RestyleReport = { applied: [], skipped: [], errors: [], before: {}, after: {}, scope_changes: [] };
    const warn = (message: string) => log(message, ESYS_LogType.WARNING);

    let view = await readPinNets();
    report.before = pick(view, items);

    if (!dryRun) await sch_PrimitiveWireSnap.activate();
    try {
        for (const item of items) {
            const pinRef = `${item.designator}.${item.pin_number}`;
            log(`restyle ${pinRef} → ${JSON.stringify(item.style)}${dryRun ? ' (dry run)' : ''}`);

            const located = await locatePin(item);
            if (!located) {
                report.errors.push({ item, error: `Pin ${pinRef} not found on the current page.` });
                continue;
            }

            const index = buildConnectionIndex(await collectPageConnections());
            const connection = describeConnectionAt(index, located.site.x, located.site.y, warn);
            const planned = planRestyle({
                item,
                connection,
                signalName: view.get(pinRef) ?? '',
                site: located.site,
                index,
                pinKeys: await allPinKeys(),
                normY: normWireY,
            });

            if (!planned.ok) {
                log(`restyle ${pinRef} skipped: ${planned.refusal.reason} — ${planned.refusal.detail}`, ESYS_LogType.WARNING);
                report.skipped.push({ item, ...planned.refusal });
                continue;
            }

            const { plan } = planned;
            if (!plan.create && !plan.remove.length && !plan.stub) {
                report.applied.push({ item, plan, noop: true });
                continue;
            }
            if (dryRun) {
                report.applied.push({ item, plan, dry_run: true });
                continue;
            }

            // 1. Create first, so the net never loses its only name ([VERIFY D]).
            let createdWireId: string | undefined;
            if (plan.stub) {
                // The symbol names the net; a named wire would itself read as a label (runtime finding).
                // Only a requested label needs the name on the wire, and createLabel() sets it.
                const stub = await sch_PrimitiveWireSnap.create(plan.stub).catch(() => undefined);
                if (!stub) {
                    report.errors.push({ item, error: `Could not create the stub wire ${JSON.stringify(plan.stub)} for ${pinRef}.` });
                    continue;
                }
                await commit(stub);
                createdWireId = safe(() => stub.getState_PrimitiveId(), undefined as string | undefined);
            }

            let createdId: string | undefined;
            if (plan.create) {
                createdId = await createSymbol(plan.create, plan.create.type === 'label' ? createdWireId ?? plan.create.wireId ?? undefined : undefined);
                if (!createdId) {
                    if (createdWireId) await sch_PrimitiveWireSnap.delete(createdWireId).catch(() => false);
                    report.errors.push({ item, error: `EasyEDA refused to create the ${plan.create.type} "${plan.net}" for ${pinRef}; nothing was removed.` });
                    continue;
                }
            }

            // 2. Then remove what the request replaces.
            const removedIds: string[] = [];
            const removedPlanned: PlannedSymbol[] = [];
            let labelRemoval: RestyleAppliedEntry['label_removal'];
            let removalError: string | undefined;
            for (const symbol of plan.remove) {
                const outcome = await removeSymbol(symbol, index);
                if (!outcome.ok) {
                    removalError = outcome.error;
                    break;
                }
                removedIds.push(symbol.primitive_id);
                const planned_ = symbolToPlanned(symbol, index);
                if (planned_) removedPlanned.push(planned_);
                if (outcome.via !== 'component_delete') labelRemoval = outcome.via;
            }

            // 3. Verify against the netlist; roll back if the net changed.
            const after = await readPinNets();
            const verdict = removalError
                ? { ok: false as const, detail: removalError }
                : verifyRestyleOutcome({ before: view, after, pinRef, style: item.style.symbol });

            if (!verdict.ok) {
                log(`restyle ${pinRef} FAILED verification: ${verdict.detail}; rolling back`, ESYS_LogType.FATAL_ERROR);
                let rolledBack = true;
                if (createdId && plan.create!.type !== 'label') {
                    const freshIndex = buildConnectionIndex(await collectPageConnections());
                    const created: ConnectionSymbol = { type: plan.create!.type, name: plan.net, direction: null, primitive_id: createdId };
                    rolledBack = (await removeSymbol(created, freshIndex)).ok && rolledBack;
                } else if (createdId && !createdWireId) {
                    // A label on an existing wire: clear the net attribute again.
                    await sch_PrimitiveWireSnap.modify(createdId, { net: '' }).catch(() => undefined);
                    rolledBack = !(await wireNet(createdId)) && rolledBack;
                }
                if (createdWireId) rolledBack = (await sch_PrimitiveWireSnap.delete(createdWireId).catch(() => false)) && rolledBack;
                for (const symbol of removedPlanned) rolledBack = Boolean(await createSymbol(symbol)) && rolledBack;

                view = await readPinNets();
                report.errors.push({
                    item,
                    error: `${verdict.detail}. ${rolledBack ? 'Changes were rolled back.' : 'Rollback incomplete: restore the checkpoint.'}`,
                    code: rolledBack ? 'ROLLED_BACK' : 'ROLLBACK_FAILED',
                });
                continue;
            }

            view = after;
            if (plan.scope_change) report.scope_changes.push({ pin: pinRef, net: plan.net, change: plan.scope_change });
            report.applied.push({
                item,
                plan,
                created_id: createdId ?? null,
                removed_ids: removedIds,
                ...(labelRemoval ? { label_removal: labelRemoval } : {}),
                ...(plan.create?.type === 'label' && lastLabelCreation ? { label_creation: lastLabelCreation } : {}),
            });
        }
    } finally {
        if (!dryRun) sch_PrimitiveWireSnap.deactivate();
    }

    report.after = pick(view, items);
    return report;
}
