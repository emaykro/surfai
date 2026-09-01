import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Activity, MousePointerClick, ShieldCheck, TrendingUp, Users, BarChart3 } from "lucide-react";

export default function DashboardPage() {
  return (
    <div className="flex flex-col gap-8">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-3xl font-bold tracking-tight">Overview</h1>
          <p className="text-muted-foreground mt-1">
            Real-time behavioral analytics and ML predictions.
          </p>
        </div>
        <div className="flex items-center gap-4">
          <Badge variant="outline" className="px-3 py-1 bg-primary/10 text-primary border-primary/20">
            Model: v3-site-aware (AUC 0.97)
          </Badge>
          <span className="text-sm text-muted-foreground">Last updated: Just now</span>
        </div>
      </div>

      <div className="grid gap-4 md:grid-cols-2 lg:grid-cols-4">
        <Card className="bg-card border-border/50 shadow-sm">
          <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
            <CardTitle className="text-sm font-medium">Total Sessions</CardTitle>
            <Users className="h-4 w-4 text-muted-foreground" />
          </CardHeader>
          <CardContent>
            <div className="text-2xl font-bold">10,482</div>
            <p className="text-xs text-muted-foreground mt-1">
              <span className="text-emerald-500 font-medium">+12.5%</span> from last week
            </p>
          </CardContent>
        </Card>
        <Card className="bg-card border-border/50 shadow-sm">
          <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
            <CardTitle className="text-sm font-medium">High Intent Detected</CardTitle>
            <Activity className="h-4 w-4 text-primary" />
          </CardHeader>
          <CardContent>
            <div className="text-2xl font-bold text-primary">843</div>
            <p className="text-xs text-muted-foreground mt-1">
              Sent to Yandex Metrica / GA4
            </p>
          </CardContent>
        </Card>
        <Card className="bg-card border-border/50 shadow-sm">
          <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
            <CardTitle className="text-sm font-medium">Estimated CPA Drop</CardTitle>
            <TrendingUp className="h-4 w-4 text-emerald-500" />
          </CardHeader>
          <CardContent>
            <div className="text-2xl font-bold text-emerald-500">-23.4%</div>
            <p className="text-xs text-muted-foreground mt-1">
              Saved ~₽45,200 ad spend
            </p>
          </CardContent>
        </Card>
        <Card className="bg-card border-border/50 shadow-sm">
          <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
            <CardTitle className="text-sm font-medium">Bot Traffic Blocked</CardTitle>
            <ShieldCheck className="h-4 w-4 text-muted-foreground" />
          </CardHeader>
          <CardContent>
            <div className="text-2xl font-bold">1,204</div>
            <p className="text-xs text-muted-foreground mt-1">
              <span className="text-destructive font-medium">11.4%</span> of total traffic
            </p>
          </CardContent>
        </Card>
      </div>

      <div className="grid gap-4 md:grid-cols-2 lg:grid-cols-7">
        <Card className="col-span-4 bg-card border-border/50 shadow-sm">
          <CardHeader>
            <CardTitle>Conversion Intent Trend</CardTitle>
            <CardDescription>
              Real vs Synthetic Conversions over the last 7 days.
            </CardDescription>
          </CardHeader>
          <CardContent className="h-[300px] flex items-center justify-center border-t border-border/50 bg-muted/20">
            <div className="flex flex-col items-center text-muted-foreground gap-2">
              <BarChart3 className="h-8 w-8 opacity-50" />
              <span>Chart component placeholder</span>
            </div>
          </CardContent>
        </Card>
        
        <Card className="col-span-3 bg-card border-border/50 shadow-sm">
          <CardHeader>
            <CardTitle>Recent High-Intent Sessions</CardTitle>
            <CardDescription>
              Sessions with ML score &gt; 0.85 currently active.
            </CardDescription>
          </CardHeader>
          <CardContent>
            <div className="space-y-6">
              {[1, 2, 3, 4].map((i) => (
                <div key={i} className="flex items-center">
                  <div className="flex h-9 w-9 items-center justify-center rounded-full border border-border bg-muted/50">
                    <MousePointerClick className="h-4 w-4 text-primary" />
                  </div>
                  <div className="ml-4 space-y-1">
                    <p className="text-sm font-medium leading-none">Session #{1040 + i}</p>
                    <p className="text-sm text-muted-foreground">
                      Moscow, RU • Safari iOS
                    </p>
                  </div>
                  <div className="ml-auto font-medium text-primary">0.9{i}</div>
                </div>
              ))}
            </div>
          </CardContent>
        </Card>
      </div>
    </div>
  );
}
