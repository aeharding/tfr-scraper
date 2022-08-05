import cheerio from "cheerio";
import { fetch } from "undici";
import { setLastRefreshedDate } from "./lastRefreshed";
import { client } from "./mongodb";

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
  };
}

interface NotamInfo {
  notamNumber: string;
  domesticLocation: string;
}

async function fetchTFRs(): Promise<NotamInfo[]> {
  const tfrsResponse = await fetch("https://tfr.faa.gov/tfr2/list.html");

  if (!tfrsResponse.ok)
    throw new Error(
      `Scraping tfr.faa.gov failed: Status code ${tfrsResponse.status}`
    );

  const tfrsText = await tfrsResponse.text();
  const $ = cheerio.load(tfrsText);

  let tfrs: NotamInfo[] = [];

  $("table td > a").each((i, link) => {
    if (
      link.attribs["href"] &&
      link.attribs["href"].match(/save_pages/) &&
      /^\d\/\d{4}$/.test($(link).text().trim())
    ) {
      let domesticLocation: string | undefined;
      $(link.parentNode?.parentNode!)
        .children()
        .each((_, td) => {
          if (domesticLocation) return;

          if (/^[A-Z]{3}$/.test($(td).text().trim())) {
            domesticLocation = $(td).text().trim();
          }
        });

      if (!domesticLocation) return;
      tfrs.push({
        notamNumber: $(link).text(),
        domesticLocation,
      });
    }
  });

  // Smoke test, something on the page is broken, there's always many TFRs
  if (tfrs.length < 10) {
    throw new Error("tfr.faa.gov appears to have invalid data");
  }

  return tfrs;
}

async function getTFRDetail(
  notamNumber: string,
  domesticLocation: string
): Promise<TFR> {
  const tfrRequest = await fetch(
    `${faaAPI}/notams?${new URLSearchParams({
      notamNumber,
      domesticLocation,
    })}`,
    { headers: { client_id, client_secret } }
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
    { unique: true }
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
    { projection: { "properties.coreNOTAMData.notam.number": true } }
  );

  const alreadyInserted = await (
    await alreadyInsertedCursor.toArray()
  ).map((ret) => ret.properties.coreNOTAMData.notam.number);

  const needsInsertion = notams.filter(
    ({ notamNumber }) => !alreadyInserted.includes(notamNumber)
  );

  for (const { notamNumber, domesticLocation } of needsInsertion) {
    const payload = await getTFRDetail(notamNumber, domesticLocation);

    if (!payload) {
      console.log(`Could not find TFR ${notamNumber}`);
      continue;
    }

    // Sometimes we're provided data with invalid collections
    if (payload.geometry && Object.keys(payload.geometry).length <= 1) {
      delete payload.geometry;
    }

    await collection.insertOne(payload);
  }

  await setLastRefreshedDate();

  client.close();
}
