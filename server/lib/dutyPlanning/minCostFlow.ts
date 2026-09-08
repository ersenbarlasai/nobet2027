/**
 * Min-cost max-flow (successive shortest augmenting path, SPFA/Bellman-Ford).
 *
 * Bu motor `solver.ts` (v1/v2) ve `solverV3.ts` tarafından ORTAK kullanılır —
 * iki ayrı kopya tutulmaz. Davranışı v1'den BİREBİR taşınmıştır (bkz. v1 solver
 * testleri): `run()` kalıntı grafta genişletme yolu KALMAYANA dek tekrarlar,
 * bu yüzden sonuç HER ZAMAN ağın gerçek MAKSİMUM akışıdır; maliyet yalnız
 * maksimum akışlı çözümler ARASINDA sıralama yapar.
 *
 * Negatif KENAR maliyetleri desteklenir (SPFA). Dışbükey (monoton artan)
 * basamaklı maliyetler kullanıldığı sürece kalıntı grafta negatif ÇEVRİM
 * oluşmaz — bu, successive-shortest-path'in optimalliği için gereken koşuldur.
 *
 * Bütün kapasiteler 1 birimdir (basamaklı kenarlar ayrı ayrı eklenir), bu
 * yüzden her genişletme tam olarak 1 birim akış taşır ve darboğaz araması
 * gerekmez.
 */

interface FlowEdge {
  to: number;
  cap: number;
  cost: number;
  flow: number;
}

export class MinCostFlow {
  private readonly nodeCount: number;
  private readonly graph: number[][];
  private readonly edges: FlowEdge[] = [];

  constructor(nodeCount: number) {
    this.nodeCount = nodeCount;
    this.graph = Array.from({ length: nodeCount }, () => []);
  }

  addEdge(from: number, to: number, cap: number, cost: number): void {
    this.graph[from].push(this.edges.length);
    this.edges.push({ to, cap, cost, flow: 0 });
    this.graph[to].push(this.edges.length);
    this.edges.push({ to: from, cap: 0, cost: -cost, flow: 0 });
  }

  /** Kalıntı grafta SOURCE→SINK en ucuz genişletme yolunu bulana dek tekrarlar. */
  run(source: number, sink: number): void {
    for (;;) {
      const dist = new Array<number>(this.nodeCount).fill(Number.POSITIVE_INFINITY);
      const inQueue = new Array<boolean>(this.nodeCount).fill(false);
      const prevEdge = new Array<number>(this.nodeCount).fill(-1);
      dist[source] = 0;
      const queue: number[] = [source];
      inQueue[source] = true;
      while (queue.length > 0) {
        const u = queue.shift() as number;
        inQueue[u] = false;
        for (const edgeIndex of this.graph[u]) {
          const edge = this.edges[edgeIndex];
          if (edge.cap - edge.flow <= 0) continue;
          const nd = dist[u] + edge.cost;
          if (nd < dist[edge.to]) {
            dist[edge.to] = nd;
            prevEdge[edge.to] = edgeIndex;
            if (!inQueue[edge.to]) {
              inQueue[edge.to] = true;
              queue.push(edge.to);
            }
          }
        }
      }
      if (!Number.isFinite(dist[sink])) break;

      let v = sink;
      while (v !== source) {
        const edgeIndex = prevEdge[v];
        this.edges[edgeIndex].flow += 1;
        this.edges[edgeIndex ^ 1].flow -= 1;
        v = this.edges[edgeIndex ^ 1].to;
      }
    }
  }

  flowOn(edgeIndex: number): number {
    return this.edges[edgeIndex].flow;
  }

  /** Sıradaki `addEdge` çağrısının alacağı (ileri yön) kenar indeksi. */
  nextEdgeIndex(): number {
    return this.edges.length;
  }
}
