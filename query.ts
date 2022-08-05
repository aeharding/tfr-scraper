import { getLastRefreshedDate } from "./lastRefreshed";
import { client } from "./mongodb";
import { TFR } from "./scraper";

interface QueryParams {
  lat: number;
  lon: number;
  radialDistance: number;
}

export default async function query(payload: QueryParams) {
  await client.connect();

  const lastRefreshedDate = await getLastRefreshedDate();
  const tfrs = await getTfrs(payload);

  client.close();

  return { items: tfrs, lastRefreshedDate };
}

async function getTfrs({ lat, lon, radialDistance }: QueryParams) {
  const collection = client.db("data").collection<TFR>("tfrs");

  const pointer = await collection.find({
    geometry: {
      $near: {
        $geometry: {
          type: "Point",
          coordinates: [lon, lat],
        },
        $maxDistance: radialDistance,
        $minDistance: 0,
      },
    },
  });

  return await pointer.toArray();
}
