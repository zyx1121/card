import { CardCanvas } from "@/components/card-canvas";
import { resolveBackground, resolveFx, resolveOutline } from "@/lib/card-fx";
import { resolvePreset } from "@/lib/card-presets";

export default async function Home({ searchParams }: PageProps<"/">) {
  const { preset, fx, outline, bg } = await searchParams;
  return (
    <main className="bg-background flex h-full w-full items-center justify-center">
      <CardCanvas
        preset={resolvePreset(preset)}
        fx={resolveFx(fx)}
        outline={resolveOutline(outline)}
        background={resolveBackground(bg)}
      />
    </main>
  );
}
