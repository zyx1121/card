import { CardCanvas } from "@/components/card-canvas";
import { resolveFx } from "@/lib/card-fx";
import { resolvePreset } from "@/lib/card-presets";

export default async function Home({ searchParams }: PageProps<"/">) {
  const { preset, fx } = await searchParams;
  return (
    <main className="bg-background flex h-full w-full items-center justify-center">
      <CardCanvas preset={resolvePreset(preset)} fx={resolveFx(fx)} />
    </main>
  );
}
