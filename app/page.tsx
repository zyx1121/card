import { CardCanvas } from "@/components/card-canvas";
import { resolvePreset } from "@/lib/card-presets";

export default async function Home({ searchParams }: PageProps<"/">) {
  const { preset } = await searchParams;
  return (
    <main className="bg-background flex h-full w-full items-center justify-center">
      <CardCanvas preset={resolvePreset(preset)} />
    </main>
  );
}
