// Assume database is already open

import { client } from "./mongodb";

export async function getLastRefreshedDate(): Promise<Date | undefined> {
  const lastRefreshedDateCollection = client
    .db("data")
    .collection<{ date: Date }>("lastRefreshedDate");

  const document = await lastRefreshedDateCollection.findOne({});

  return document?.date;
}

export async function setLastRefreshedDate(): Promise<void> {
  const lastRefreshedDateCollection = client
    .db("data")
    .collection<{ date: Date }>("lastRefreshedDate");

  await lastRefreshedDateCollection.updateOne(
    {},
    {
      $set: { date: new Date() },
    },
    { upsert: true }
  );
}
