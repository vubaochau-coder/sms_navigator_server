/**
 * In-Memory Firestore adapter.
 *
 * Emulates the subset of the Cloud Firestore API used by this service
 * (collections, documents, where/limit/orderBy queries) so that `npm test`
 * and local mock-mode runs work 100% offline without credentials.
 */

export type MockFieldValue = unknown;
export type MockDocumentData = Record<string, MockFieldValue>;

export type MockWhereFilterOp =
  | '=='
  | '!='
  | '>'
  | '>='
  | '<'
  | '<='
  | 'array-contains'
  | 'in'
  | 'not-in';

export interface MockSetOptions {
  merge?: boolean;
}

let autoIdCounter = 0;

function generateAutoId(): string {
  autoIdCounter += 1;
  const random = Math.random().toString(36).substring(2, 10);
  return `mock_${Date.now().toString(36)}_${random}${autoIdCounter.toString(36)}`;
}

function deepClone<T>(value: T): T {
  if (value === null || typeof value !== 'object') {
    return value;
  }
  if (Array.isArray(value)) {
    return value.map((item) => deepClone(item)) as unknown as T;
  }
  if (value instanceof Date) {
    return new Date(value.getTime()) as unknown as T;
  }
  const clone: Record<string, unknown> = {};
  for (const [key, val] of Object.entries(value as Record<string, unknown>)) {
    clone[key] = deepClone(val);
  }
  return clone as T;
}

/** Firestore rejects `undefined` field values - mirror that by stripping them. */
export function stripUndefinedFields(data: MockDocumentData): MockDocumentData {
  const cleaned: MockDocumentData = {};
  for (const [key, value] of Object.entries(data)) {
    if (value === undefined) continue;
    if (value !== null && typeof value === 'object' && !Array.isArray(value) && !(value instanceof Date)) {
      cleaned[key] = stripUndefinedFields(value as MockDocumentData);
    } else {
      cleaned[key] = value;
    }
  }
  return cleaned;
}

function matchesOp(actual: MockFieldValue, op: MockWhereFilterOp, expected: MockFieldValue): boolean {
  switch (op) {
    case '==':
      return actual === expected;
    case '!=':
      return actual !== expected;
    case 'in':
    case 'not-in': {
      const list = Array.isArray(expected) ? expected : [];
      const contains = list.some((item) => item === actual);
      return op === 'in' ? contains : !contains;
    }
    case 'array-contains':
      return Array.isArray(actual) && actual.some((item) => item === expected);
    case '>':
      return typeof actual === 'number' && typeof expected === 'number' && actual > expected;
    case '>=':
      return typeof actual === 'number' && typeof expected === 'number' && actual >= expected;
    case '<':
      return typeof actual === 'number' && typeof expected === 'number' && actual < expected;
    case '<=':
      return typeof actual === 'number' && typeof expected === 'number' && actual <= expected;
    default:
      return false;
  }
}

function getField(data: MockDocumentData, fieldPath: string): MockFieldValue {
  return fieldPath.split('.').reduce<MockFieldValue>((acc, key) => {
    if (acc !== null && typeof acc === 'object' && !Array.isArray(acc)) {
      return (acc as MockDocumentData)[key];
    }
    return undefined;
  }, data as MockFieldValue);
}

export class MockDocumentSnapshot {
  constructor(
    public readonly id: string,
    public readonly ref: MockDocumentReference,
    private readonly dataOrNull: MockDocumentData | null
  ) {}

  public get exists(): boolean {
    return this.dataOrNull !== null;
  }

  public data(): MockDocumentData | undefined {
    return this.dataOrNull ? deepClone(this.dataOrNull) : undefined;
  }
}

export class MockQuerySnapshot {
  constructor(public readonly docs: MockDocumentSnapshot[]) {}

  public get empty(): boolean {
    return this.docs.length === 0;
  }

  public get size(): number {
    return this.docs.length;
  }

  public forEach(callback: (snapshot: MockDocumentSnapshot) => void): void {
    this.docs.forEach(callback);
  }
}

interface QueryConstraint {
  type: 'where';
  field: string;
  op: MockWhereFilterOp;
  value: MockFieldValue;
}

export class MockQuery {
  constructor(
    protected readonly store: Map<string, MockDocumentData>,
    private readonly constraints: QueryConstraint[] = [],
    private readonly limitCount: number | null = null,
    private readonly orderByField: string | null = null,
    private readonly orderByDirection: 'asc' | 'desc' = 'asc'
  ) {}

  public where(field: string, op: MockWhereFilterOp, value: MockFieldValue): MockQuery {
    return new MockQuery(
      this.store,
      [...this.constraints, { type: 'where', field, op, value }],
      this.limitCount,
      this.orderByField,
      this.orderByDirection
    );
  }

  public limit(count: number): MockQuery {
    return new MockQuery(this.store, this.constraints, count, this.orderByField, this.orderByDirection);
  }

  public orderBy(field: string, direction: 'asc' | 'desc' = 'asc'): MockQuery {
    return new MockQuery(this.store, this.constraints, this.limitCount, field, direction);
  }

  public async get(): Promise<MockQuerySnapshot> {
    const entries = Array.from(this.store.entries());
    let snapshots = entries.map(
      ([id, data]) => new MockDocumentSnapshot(id, new MockDocumentReference(id, this.store), deepClone(data))
    );

    for (const constraint of this.constraints) {
      snapshots = snapshots.filter((snapshot) => {
        const actual = getField(snapshot.data() ?? {}, constraint.field);
        return matchesOp(actual, constraint.op, constraint.value);
      });
    }

    if (this.orderByField) {
      const dir = this.orderByDirection === 'desc' ? -1 : 1;
      snapshots.sort((a, b) => {
        const av = getField(a.data() ?? {}, this.orderByField!);
        const bv = getField(b.data() ?? {}, this.orderByField!);
        if (av === bv) return 0;
        if (av === undefined) return 1;
        if (bv === undefined) return -1;
        return (av as number) < (bv as number) ? -1 * dir : 1 * dir;
      });
    }

    if (this.limitCount !== null) {
      snapshots = snapshots.slice(0, this.limitCount);
    }

    return new MockQuerySnapshot(snapshots);
  }
}

export class MockDocumentReference {
  constructor(
    public readonly id: string,
    private readonly store: Map<string, MockDocumentData>
  ) {}

  public async get(): Promise<MockDocumentSnapshot> {
    const data = this.store.get(this.id);
    return new MockDocumentSnapshot(this.id, this, data ? deepClone(data) : null);
  }

  public async set(data: MockDocumentData, options?: MockSetOptions): Promise<void> {
    const cleaned = stripUndefinedFields(deepClone(data));
    if (options?.merge) {
      const existing = this.store.get(this.id) ?? {};
      this.store.set(this.id, { ...existing, ...cleaned });
    } else {
      this.store.set(this.id, cleaned);
    }
  }

  public async update(data: MockDocumentData): Promise<void> {
    if (!this.store.has(this.id)) {
      const error = new Error(`No document to update: ${this.id}`) as Error & { code: string };
      error.code = 'not-found';
      throw error;
    }
    const cleaned = stripUndefinedFields(deepClone(data));
    const existing = this.store.get(this.id) ?? {};
    this.store.set(this.id, { ...existing, ...cleaned });
  }

  public async delete(): Promise<void> {
    this.store.delete(this.id);
  }
}

export class MockCollectionReference extends MockQuery {
  constructor(
    public readonly id: string,
    store: Map<string, MockDocumentData>
  ) {
    super(store);
  }

  public doc(docId?: string): MockDocumentReference {
    const id = docId ?? generateAutoId();
    return new MockDocumentReference(id, this.store);
  }

  public async add(data: MockDocumentData): Promise<MockDocumentReference> {
    const ref = this.doc();
    await ref.set(data);
    return ref;
  }
}

export class MockFirestore {
  private readonly collections = new Map<string, Map<string, MockDocumentData>>();

  public collection(name: string): MockCollectionReference {
    let store = this.collections.get(name);
    if (!store) {
      store = new Map<string, MockDocumentData>();
      this.collections.set(name, store);
    }
    return new MockCollectionReference(name, store);
  }

  /** Wipes every collection - used by test setup via services' clearAll(). */
  public reset(): void {
    for (const store of this.collections.values()) {
      store.clear();
    }
  }
}

export const mockFirestore = new MockFirestore();
