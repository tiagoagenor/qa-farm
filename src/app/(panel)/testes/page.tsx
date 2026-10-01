import { ProjectChooser } from "@/components/tests/project-chooser"
import { TestCatalog } from "@/components/tests/test-catalog"

export default async function TestesPage({ searchParams }: { searchParams: Promise<{ projeto?: string }> }) {
  const { projeto } = await searchParams
  if (projeto === "robot" || projeto === "giat") return <TestCatalog key={projeto} project={projeto} />
  return <ProjectChooser />
}
