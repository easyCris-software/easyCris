import { Badge } from '@/components/ui/badge'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'

export function PowerPointPane() {
  return (
    <div className="space-y-4">
      <Card>
        <CardHeader className="space-y-2">
          <div className="flex items-center gap-2">
            <CardTitle>PowerPoint Integration</CardTitle>
            <Badge variant="secondary">Pro</Badge>
          </div>
        </CardHeader>
        <CardContent className="text-sm text-muted-foreground">
          Editable Office embedding is available in easyCris Pro. easyCris Community can still export static plot images for presentations.
        </CardContent>
      </Card>
    </div>
  )
}

export default PowerPointPane
