"use strict";

/**
 * People profiles contain third-party personal data. This module is only
 * reachable when LI_ALLOW_PEOPLE=1, and is intentionally NOT cached: no
 * profile is retained beyond the lifetime of the request.
 */
const { person: fetchPerson } = require("./sources");
const { normalizePerson } = require("./normalize");
const { ConnectorError } = require("./errors");

function peopleEnabled() {
  return process.env.LI_ALLOW_PEOPLE === "1";
}

function assertPeopleEnabled() {
  if (!peopleEnabled()) {
    throw new ConnectorError(
      "LI_PEOPLE_DISABLED",
      "People profiles are disabled by default (personal-data policy). Hosted API Everything does not expose them.",
      403
    );
  }
}

async function getPerson(slug, options = {}) {
  assertPeopleEnabled();
  const raw = await fetchPerson(slug, options);
  const profile = normalizePerson(raw.slug, raw.graph, raw.variants);
  if (raw.firstName) profile.firstName = raw.firstName;
  if (raw.lastName) profile.lastName = raw.lastName;
  return profile;
}

module.exports = { getPerson, peopleEnabled, assertPeopleEnabled };
