import { setLastRefreshedDate } from "./lastRefreshed";
import { client } from "./mongodb";

const TFR_WFS_URL =
  "https://tfr.faa.gov/geoserver/TFR/ows?service=WFS&version=1.1.0&request=GetFeature&typeName=TFR:V_TFR_LOC&maxFeatures=300&outputFormat=application/json";

const faaAPI = "https://external-api.faa.gov/notamapi/v1";
const client_id = process.env.FAA_API_CLIENT_ID || "";
const client_secret = process.env.FAA_API_CLIENT_SECRET || "";

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

async function getTFRDetail(
  notamNumber: string,
  domesticLocation: string,
): Promise<TFR> {
  const tfrRequest = await fetch(
    `${faaAPI}/notams?${new URLSearchParams({
      notamNumber,
      domesticLocation,
    })}`,
    { headers: { client_id, client_secret } },
  );

  if (!tfrRequest.ok)
    throw new Error(`FAA API seems to be down, got ${tfrRequest.status}`);

  const data = (await tfrRequest.json()) as any;

  return data.items[0];
}

export default async function () {
  const notams = await fetchTFRs();

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

  for (const { notamNumber, domesticLocation, geometries } of needsInsertion) {
    const payload = await getTFRDetail(notamNumber, domesticLocation);

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
