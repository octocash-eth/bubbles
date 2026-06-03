import { redirect } from "react-router";

import { getOctocashUrl } from "~/lib/env.server";

export async function loader() {
  return redirect(getOctocashUrl());
}
