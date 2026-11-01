import { Suspense } from "react";
import Studio from "./studio";

type RoomPageProps = {
  params: Promise<{ code: string }>;
};

async function RoomContent({ params }: RoomPageProps) {
  const { code } = await params;
  return <Studio code={code} />;
}

export default function RoomPage({ params }: RoomPageProps) {
  return (
    <Suspense
      fallback={
        <main className="flex min-h-screen items-center justify-center bg-[#080b16] text-white">
          Loading collaboration room...
        </main>
      }
    >
      <RoomContent params={params} />
    </Suspense>
  );
}
