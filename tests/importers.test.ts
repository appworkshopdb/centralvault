import { describe, expect, it } from "vitest";
import { buildInitialVault } from "../src/importers";

describe("initial import", () => {
  it("applies only the confirmed cleanup rules and keeps source categories", () => {
    const bitwarden = {
      folders: [{ id: "f1", name: "Geld" }, { id: "f2", name: "Apps" }],
      items: [
        { type: 1, name: "Otto Partner", folderId: "f2", login: { username: "otto", password: "same", uris: [{ uri: "https://otto.example" }] } },
        { type: 1, name: "Edenred", folderId: "f1", login: { username: "x", password: "y", uris: [] } },
        { type: 1, name: "Privater Dienst", folderId: "f1", login: { username: "private", password: "secret", uris: [] } },
      ],
    };
    const work = [
      { title: "Otto Portal", cat: "Login", user: "otto", pass: "same", url: "https://otto.example" },
      { title: "FTP Buntler CSV", cat: "FTP", user: "ftp", pass: "same", host: "ftp.example" },
      { title: "FTP Snaptrade", cat: "FTP", user: "ftp", pass: "same", host: "ftp.example" },
      { title: "Amazon Seller Central", cat: "Login", user: "a", pass: "one", url: "https://seller.example" },
      { title: "ACR Shop", cat: "Login", user: "b", pass: "two", url: "https://seller.example" },
    ];

    const { vault, summary } = buildInitialVault(bitwarden, work);
    expect(summary.skippedEdenred).toBe(1);
    expect(summary.mergedOtto).toBe(1);
    expect(vault.entries.filter((entry) => entry.title.includes("Otto"))).toHaveLength(1);
    expect(vault.entries.find((entry) => entry.title === "Otto Partner")?.area).toBe("work");
    expect(vault.entries.filter((entry) => entry.title.startsWith("FTP "))).toHaveLength(2);
    expect(vault.entries.filter((entry) => ["Amazon Seller Central", "ACR Shop"].includes(entry.title))).toHaveLength(2);
    expect(vault.categories.private).toContain("Geld");
    expect(vault.categories.work).toEqual(["FTP", "Login"]);
  });
});
