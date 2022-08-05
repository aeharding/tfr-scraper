import { client } from "./mongodb";
import { TFR } from "./scraper";

export default async function query({
  lat,
  lon,
  radialDistance,
}: {
  lat: number;
  lon: number;
  radialDistance: number;
}) {
  await client.connect();

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

  const tfrs = await pointer.toArray();

  client.close();

  return tfrs;
}
