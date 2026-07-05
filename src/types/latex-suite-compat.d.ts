interface String {
  contains(searchString: string, position?: number): boolean;
}

interface ReadonlyArray<T> {
  contains(searchElement: T, fromIndex?: number): boolean;
}

interface Array<T> {
  contains(searchElement: T, fromIndex?: number): boolean;
}
