import Studio from "./studio";

export default async function RoomPage({
  params,
}: {
  params: Promise<{ code: string }>;
}) {
  const { code } = await params;

  return <Studio code={code} />;
}
