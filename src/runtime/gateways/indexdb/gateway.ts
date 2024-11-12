import { openDB, IDBPDatabase } from "idb";
import { exception2Result, KeyedResolvOnce, Logger, Result, URI } from "@adviser/cement";

import { INDEXDB_VERSION } from "./version.js";
import { ensureLogger, exceptionWrapper, getKey, getStore, NotFoundError } from "../../../utils.js";
import { Gateway, GetResult } from "../../../blockstore/gateway.js";
import { PARAM, SuperThis } from "../../../types.js";
import { FPEnvelope } from "../../../blockstore/fp-envelope.js";
import { fpDeserialize, fpSerialize } from "../fp-envelope-serialize.js";

function ensureVersion(url: URI): URI {
  return url.build().defParam(PARAM.VERSION, INDEXDB_VERSION).URI();
}

interface IDBConn {
  readonly db: IDBPDatabase<unknown>;
  readonly dbName: DbName;
  readonly version: string;
  readonly url: URI;
}
const onceIndexDB = new KeyedResolvOnce<IDBConn>();

function sanitzeKey(key: string | string[]): string | string[] {
  if (key.length === 1) {
    key = key[0];
  }
  return key;
}

async function connectIdb(url: URI, sthis: SuperThis): Promise<IDBConn> {
  const dbName = getIndexDBName(url, sthis);
  const once = await onceIndexDB.get(dbName.fullDb).once(async () => {
    const db = await openDB(dbName.fullDb, 1, {
      upgrade(db) {
        ["version", "data", "wal", "meta", "idx.data", "idx.wal", "idx.meta"].map((store) => {
          db.createObjectStore(store, {
            autoIncrement: false,
          });
        });
      },
    });
    const found = await db.get("version", "version");
    const version = ensureVersion(url).getParam(PARAM.VERSION) as string;
    if (!found) {
      await db.put("version", { version }, "version");
    } else if (found.version !== version) {
      sthis.logger.Warn().Url(url).Str("version", version).Str("found", found.version).Msg("version mismatch");
    }
    return { db, dbName, version, url };
  });
  return {
    ...once,
    url: url.build().setParam(PARAM.VERSION, once.version).URI(),
  };
}

export interface DbName {
  readonly fullDb: string;
  readonly objStore: string;
  readonly connectionKey: string;
  readonly dbName: string;
}

function joinDBName(...names: string[]): string {
  return names
    .map((i) => i.replace(/^[^a-zA-Z0-9]+/g, "").replace(/[^a-zA-Z0-9-]+/g, "_"))
    .filter((i) => i.length)
    .join(".");
}

export function getIndexDBName(iurl: URI, sthis: SuperThis): DbName {
  const url = ensureVersion(iurl);
  const fullDb = url.pathname.replace(/^\/+/, "").replace(/\?.*$/, ""); // cut leading slashes
  const dbName = url.getParam(PARAM.NAME);
  if (!dbName) throw sthis.logger.Error().Str("url", url.toString()).Msg(`name not found`).AsError();
  const result = joinDBName(fullDb, dbName);
  const objStore = getStore(url, sthis, joinDBName).name;
  const connectionKey = [result, objStore].join(":");
  return {
    fullDb: result,
    objStore,
    connectionKey,
    dbName,
  };
}

const loadExternal = new ResolveOnce<Gateway>();
export class IndexDBGateway implements Gateway {
  readonly sthis: SuperThis;

  constructor(sthis: SuperThis) {
    this.sthis = sthis;
  }
  private getGateway(): Promise<Gateway> {
    return loadExternal.once(() => {
      return gatewayImport().then(({ IndexDBGatewayImpl }) => new IndexDBGatewayImpl(this.sthis));
    });
  }
  buildUrl(baseUrl: URI, key: string): Promise<Result<URI>> {
    return this.getGateway().then((gw) => gw.buildUrl(baseUrl, key));
  }
  start(baseUrl: URI): Promise<Result<URI>> {
    return this.getGateway().then((gw) => gw.start(baseUrl));
  }
  close(baseUrl: URI): Promise<VoidResult> {
    return this.getGateway().then((gw) => gw.close(baseUrl));
  }
  destroy(baseUrl: URI): Promise<VoidResult> {
    return this.getGateway().then((gw) => gw.destroy(baseUrl));
  }
  put(url: URI, body: Uint8Array): Promise<VoidResult> {
    return this.getGateway().then((gw) => gw.put(url, body));
  }
  get(url: URI): Promise<GetResult> {
    return this.getGateway().then((gw) => gw.get(url));
  }
  delete(url: URI): Promise<VoidResult> {
    return this.getGateway().then((gw) => gw.delete(url));
  }
  // subscribe?(url: URI, callback: (meta: Uint8Array) => void): Promise<UnsubscribeResult> {
  //     // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
  //     return this.getGateway().then(gw => gw.subscribe!(url, callback));
  // }
}

export class IndexDBTestStore implements TestGateway {
  readonly sthis: SuperThis;
  constructor(sthis: SuperThis) {
    this.sthis = sthis;
  }
  readonly loadExternal = new ResolveOnce<TestGateway>();
  private getGateway(): Promise<TestGateway> {
    return this.loadExternal.once(() => {
      return gatewayImport().then(({ IndexDBTestStore }) => new IndexDBTestStore(this.sthis));
    });
  }

  get(url: URI, key: string) {
    return this.getGateway().then((gw) => gw.get(url, key));
  }
}
