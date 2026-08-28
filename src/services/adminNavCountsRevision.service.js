let revision = 1;

export function bumpAdminNavCounts() {
  revision += 1;
  return revision;
}

export function getAdminNavCountsRevision() {
  return revision;
}
