interface Greeter {
  greet(name: string): string;
}

class Sample implements Greeter {
  count = 0;
  greet(name: string): string {
    return `hi ${name}`;
  }
  run(items: string[]): void {
    items.forEach((i) => console.log(i));
  }
}
