import { expect, it } from "vitest";

it("provides a Promise-returning play API for jsdom media elements", async () => {
  const video = document.createElement("video");

  const playback = video.play();
  expect(playback).toBeInstanceOf(Promise);
  await expect(playback).resolves.toBeUndefined();
});
