import { Suspense } from "react"

import { ProjectPage } from "@/components/project/project-page"

export default function ProjetoPage() {
  return (
    <Suspense>
      <ProjectPage />
    </Suspense>
  )
}
