import { openDB, IDBPDatabase } from "idb";
import { exception2Result, KeyedResolvOnce, Logger, Result, URI } from "@adviser/cement";

import { INDEXDB_VERSION } from "../version.js";
import { ensureLogger, exceptionWrapper, getKey, getStore, NotFoundError } from "../../../../utils.js";
import { Gateway, GetResult, TestGateway } from "../../../../blockstore/gateway.js";
import { SuperThis } from "../../../../types.js";

function ensureVersion(url: URI): URI {
  return url.build().defParam(PARAM.VERSION, INDEXDB_VERSION).URI();
}

interface IDBConn {
  readonly db: IDBPDatabase<unknown>;
  readonly dbName: DbName;
  readonly version: string;
  readonly url: URI;
}

function sanitzeKey(key: string | string[]): string | string[] {
  if (key.length === 1) {
    key = key[0];
  }
  return key;
}

const onceConn = new KeyedResolvOnce<IDBConn>();
async function connectIdb(url: URI, sthis: SuperThis): Promise<IDBConn> {
  const dbName = getIndexDBName(url, sthis);
  const once = await onceConn.get(dbName.fullDb).once(async () => {
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

export class IndexDBGatewayImpl implements Gateway {
  readonly logger: Logger;
  readonly sthis: SuperThis;
  constructor(sthis: SuperThis) {
    this.logger = ensureLogger(sthis, "IndexDBGateway");
    this.sthis = sthis;
  }

  // _db: IDBPDatabase<unknown> = {} as IDBPDatabase<unknown>;

  async start(baseURL: URI): Promise<Result<URI>> {
    return exception2Result(async () => {
      this.logger.Debug().Url(baseURL).Msg("starting");
      await this.sthis.start();
      const ic = await connectIdb(baseURL, this.sthis);
      this.logger.Debug().Url(ic.url).Msg("started");
      return ic.url;
    });
  }
  async close(): Promise<Result<void>> {
    return Result.Ok(undefined);
  }
  async destroy(baseUrl: URI): Promise<Result<void>> {
    return exception2Result(async () => {
      // return deleteDB(getIndexDBName(this.url).fullDb);
      const type = getStore(baseUrl, this.sthis, joinDBName).name;
      // console.log("IndexDBDataStore:destroy", type);
      const idb = await connectIdb(baseUrl, this.sthis);
      const trans = idb.db.transaction(type, "readwrite");
      const object_store = trans.objectStore(type);
      const toDelete = [];
      for (let cursor = await object_store.openCursor(); cursor; cursor = await cursor.continue()) {
        toDelete.push(cursor.primaryKey);
      }
      for (const key of toDelete) {
        await trans.db.delete(type, key);
      }
      await trans.done;
    });
  }

  buildUrl(baseUrl: URI, key: string): Promise<Result<URI>> {
    return Promise.resolve(Result.Ok(baseUrl.build().setParam(PARAM.KEY, key).URI()));
  }

  async get<S>(url: URI): Promise<GetResult<S>> {
    return exceptionWrapper(async () => {
      const key = getKey(url, this.logger);
      const store = getStore(url, this.sthis, joinDBName).name;
      this.logger.Debug().Url(url).Str("key", key).Str("store", store).Msg("getting");
      const { db } = await connectIdb(url, this.sthis);
      const tx = db.transaction([store], "readonly");
      const bytes = await tx.objectStore(store).get(sanitzeKey(key));
      await tx.done;
      if (!bytes) {
        return Result.Err(new NotFoundError(`missing ${key}`));
      }
      return fpDeserialize<S>(this.sthis, url, bytes) as Promise<GetResult<S>>;
    });
  }
  async put<T>(url: URI, value: FPEnvelope<T>) {
    return exception2Result(async () => {
      const key = getKey(url, this.logger);
      const store = getStore(url, this.sthis, joinDBName).name;
      this.logger.Debug().Url(url).Str("key", key).Str("store", store).Msg("putting");
      const { db } = await connectIdb(url, this.sthis);
      const tx = db.transaction([store], "readwrite");
      await tx.objectStore(store).put(value, sanitzeKey(key));
      await tx.done;
    });
  }
  async delete(url: URI) {
    return exception2Result(async () => {
      const key = getKey(url, this.logger);
      const store = getStore(url, this.sthis, joinDBName).name;
      this.logger.Debug().Url(url).Str("key", key).Str("store", store).Msg("deleting");
      const { db } = await connectIdb(url, this.sthis);
      const tx = db.transaction([store], "readwrite");
      await tx.objectStore(store).delete(sanitzeKey(key));
      await tx.done;
      return Result.Ok(undefined);
    });
  }

  async getPlain(url: URI, key: string) {
    const ic = await connectIdb(url, this.sthis);
    const store = getStore(ic.url, this.sthis, joinDBName).name;
    this.logger.Debug().Str("key", key).Str("store", store).Msg("getting");
    let bytes = await ic.db.get(store, sanitzeKey(key));
    this.logger.Debug().Str("key", key).Str("store", store).Int("len", bytes.length).Msg("got");
    if (typeof bytes === "string") {
      bytes = this.sthis.txt.encode(bytes);
    }
    return Result.Ok(bytes as Uint8Array);
  }
}