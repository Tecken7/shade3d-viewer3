export const dynamic = "force-dynamic";
export const revalidate = 0;

import ClientPage from "./ClientPage.jsx";

export default function Page() {
  // Server komponent jen předá klientskou stránku
  return <ClientPage />;
}
