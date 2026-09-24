import { QueueDetail } from "@/components/queues/queue-detail"

export default async function FilaPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params
  return <QueueDetail id={id} />
}
