import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { ShieldCheck, ShieldAlert, MousePointerClick, Search } from "lucide-react";
import { Input } from "@/components/ui/input";

// Dummy data representing the backend ML output and session records
const sessions = [
  { id: "1041", date: "2026-04-30 14:02", location: "Moscow, RU", device: "Safari iOS", intent: 0.94, botScore: 0.01, duration: "1m 42s" },
  { id: "1042", date: "2026-04-30 14:05", location: "St. Petersburg, RU", device: "Chrome Desktop", intent: 0.88, botScore: 0.05, duration: "3m 15s" },
  { id: "1043", date: "2026-04-30 14:12", location: "Kazan, RU", device: "Yandex Browser", intent: 0.12, botScore: 0.98, duration: "4s", isBot: true },
  { id: "1044", date: "2026-04-30 14:18", location: "Novosibirsk, RU", device: "Chrome Android", intent: 0.65, botScore: 0.02, duration: "45s" },
  { id: "1045", date: "2026-04-30 14:21", location: "London, UK", device: "HeadlessChrome", intent: 0.05, botScore: 0.99, duration: "1s", isBot: true },
];

export default function SessionsPage() {
  return (
    <div className="flex flex-col gap-8">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-3xl font-bold tracking-tight">Sessions Explorer</h1>
          <p className="text-muted-foreground mt-1">
            Analyze individual user paths, intent scores, and bot indicators.
          </p>
        </div>
      </div>

      <Card className="bg-card border-border/50 shadow-sm">
        <CardHeader className="flex flex-row items-center justify-between">
          <div>
            <CardTitle>Recent Sessions</CardTitle>
            <CardDescription>Live feed of user sessions scored by CatBoost v3.</CardDescription>
          </div>
          <div className="relative w-64">
            <Search className="absolute left-2.5 top-2.5 h-4 w-4 text-muted-foreground" />
            <Input
              type="search"
              placeholder="Filter sessions..."
              className="w-full bg-background pl-9 border-border/50 focus-visible:ring-primary/50"
            />
          </div>
        </CardHeader>
        <CardContent>
          <Table>
            <TableHeader>
              <TableRow className="border-border/50 hover:bg-transparent">
                <TableHead className="w-[100px]">Session ID</TableHead>
                <TableHead>Time</TableHead>
                <TableHead>Geo & Device</TableHead>
                <TableHead>Duration</TableHead>
                <TableHead>ML Intent</TableHead>
                <TableHead className="text-right">Anti-Fraud</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {sessions.map((session) => (
                <TableRow key={session.id} className="border-border/50 cursor-pointer hover:bg-muted/30">
                  <TableCell className="font-medium">#{session.id}</TableCell>
                  <TableCell className="text-muted-foreground">{session.date}</TableCell>
                  <TableCell>
                    <div className="flex flex-col">
                      <span>{session.location}</span>
                      <span className="text-xs text-muted-foreground">{session.device}</span>
                    </div>
                  </TableCell>
                  <TableCell className="text-muted-foreground">{session.duration}</TableCell>
                  <TableCell>
                    {session.isBot ? (
                      <span className="text-muted-foreground">—</span>
                    ) : (
                      <Badge 
                        variant="outline" 
                        className={session.intent > 0.8 ? "bg-primary/10 text-primary border-primary/20" : "bg-muted text-muted-foreground border-border"}
                      >
                        {session.intent.toFixed(2)}
                      </Badge>
                    )}
                  </TableCell>
                  <TableCell className="text-right">
                    {session.isBot ? (
                      <Badge variant="outline" className="bg-destructive/10 text-destructive border-destructive/20 gap-1">
                        <ShieldAlert className="h-3 w-3" />
                        Bot ({session.botScore.toFixed(2)})
                      </Badge>
                    ) : (
                      <Badge variant="outline" className="bg-emerald-500/10 text-emerald-500 border-emerald-500/20 gap-1">
                        <ShieldCheck className="h-3 w-3" />
                        Clean
                      </Badge>
                    )}
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </CardContent>
      </Card>
    </div>
  );
}
