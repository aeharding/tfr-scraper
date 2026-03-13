import { delay, retry } from "es-toolkit";
import { setLastRefreshedDate } from "./lastRefreshed";
import { client } from "./mongodb";

const TFR_WFS_URL =
  "https://tfr.faa.gov/geoserver/TFR/ows?service=WFS&version=1.1.0&request=GetFeature&typeName=TFR:V_TFR_LOC&maxFeatures=300&outputFormat=application/json";

const nmsApiHost = process.env.NMS_API_HOST || "";
const nmsApiKey = process.env.NMS_API_KEY || "";
const nmsApiSecret = process.env.NMS_API_SECRET || "";

async function getAccessToken(): Promise<string> {
  const res = await fetch(`${nmsApiHost}/v1/auth/token`, {
    method: "POST",
    headers: {
      Authorization: `Basic ${btoa(`${nmsApiKey}:${nmsApiSecret}`)}`,
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body: "grant_type=client_credentials",
  });

  if (!res.ok) {
    const body = await res.text();
    throw new Error(`NMS auth failed (${res.status}): ${body}`);
  }

  const data = (await res.json()) as { access_token: string };
  return data.access_token;
}

export interface TFR {
  properties: {
    coreNOTAMData: {
      notam: {
        id: string;
        number: string;
        accountId: string;
      };
    };
  };
  geometry?: {
    type: string;
    coordinates?: number[][][] | number[][][][];
  };
}

interface WFSGeometry {
  type: string;
  coordinates: number[][][] | number[][][][];
}

interface NotamInfo {
  notamNumber: string;
  domesticLocation: string;
  geometries: WFSGeometry[];
}

async function fetchTFRs(): Promise<NotamInfo[]> {
  const response = await fetch(TFR_WFS_URL);

  if (!response.ok)
    throw new Error(
      `Fetching TFR GeoJSON failed: Status code ${response.status}`,
    );

  const data = await response.json();

  const byNotam = new Map<string, NotamInfo>();

  for (const feature of data.features) {
    const notamNumber = feature.properties.NOTAM_KEY.split("-")[0];
    const domesticLocation = feature.properties.CNS_LOCATION_ID;

    if (!byNotam.has(notamNumber)) {
      byNotam.set(notamNumber, {
        notamNumber,
        domesticLocation,
        geometries: [],
      });
    }

    if (feature.geometry) {
      byNotam.get(notamNumber)!.geometries.push(feature.geometry);
    }
  }

  const notams = Array.from(byNotam.values());

  // Smoke test, something in the payload is broken, there's always many TFRs
  if (notams.length < 10) {
    throw new Error("TFR WFS endpoint appears to have invalid data");
  }

  return notams;
}

function buildGeometry(geometries: WFSGeometry[]): TFR["geometry"] {
  if (geometries.length === 0) return undefined;
  if (geometries.length === 1) return geometries[0];

  return {
    type: "MultiPolygon",
    coordinates: geometries.map((g) => g.coordinates) as number[][][][],
  };
}

class RateLimitError extends Error {}

async function getTFRDetail(
  notamNumber: string,
  location: string,
  accessToken: string,
): Promise<TFR> {
  return retry(
    async () => {
      const tfrRequest = await fetch(
        `${nmsApiHost}/nmsapi/v1/notams?${new URLSearchParams({
          notamNumber,
          location,
        })}`,
        {
          headers: {
            Authorization: `Bearer ${accessToken}`,
            nmsResponseFormat: "GEOJSON",
          },
        },
      );

      if (tfrRequest.status === 429) throw new RateLimitError();

      if (!tfrRequest.ok)
        throw new Error(`NMS API error: ${tfrRequest.status}`);

      const data = (await tfrRequest.json()) as any;

      return data.data.geojson[0];
    },
    {
      retries: 5,
      delay: (attempt) => 2 ** attempt * 1_000,
      shouldRetry: (error) => error instanceof RateLimitError,
    },
  );
}

export default async function () {
  const [notams, accessToken] = await Promise.all([
    fetchTFRs(),
    getAccessToken(),
  ]);

  await client.connect();

  const collection = client.db("data").collection<TFR>("tfrs");

  await collection.createIndex({ geometry: "2dsphere" });
  await collection.createIndex(
    {
      "properties.coreNOTAMData.notam.number": 1,
      "properties.coreNOTAMData.notam.accountId": 1,
    },
    { unique: true },
  );

  await collection.deleteMany({
    "properties.coreNOTAMData.notam.number": {
      $nin: notams.map(({ notamNumber }) => notamNumber),
    },
  });

  const alreadyInsertedCursor = await collection.find(
    {
      "properties.coreNOTAMData.notam.number": {
        $in: notams.map(({ notamNumber }) => notamNumber),
      },
    },
    { projection: { "properties.coreNOTAMData.notam.number": true } },
  );

  const alreadyInserted = (await alreadyInsertedCursor.toArray()).map(
    (ret) => ret.properties.coreNOTAMData.notam.number,
  );

  const needsInsertion = notams.filter(
    ({ notamNumber }) => !alreadyInserted.includes(notamNumber),
  );

  for (let i = 0; i < needsInsertion.length; i++) {
    if (i > 0) await delay(200);
    const { notamNumber, domesticLocation, geometries } = needsInsertion[i];
    const payload = await getTFRDetail(
      notamNumber,
      domesticLocation,
      accessToken,
    );

    if (!payload) {
      console.log(`Could not find TFR ${notamNumber}`);
      continue;
    }

    // Use geometry from WFS endpoint instead of NOTAM API
    const geometry = buildGeometry(geometries);
    if (geometry) {
      payload.geometry = geometry;
    } else {
      delete payload.geometry;
    }

    await collection.insertOne(payload);
  }

  await setLastRefreshedDate();

  client.close();
}
